package velero

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

var (
	backupStorageLocations = schema.GroupVersionResource{Group: "velero.io", Version: "v1", Resource: "backupstoragelocations"}
	volumeSnapshotLocation = schema.GroupVersionResource{Group: "velero.io", Version: "v1", Resource: "volumesnapshotlocations"}
)

// AnnotationLocation names the Velero location a Secret was written for, as
// `<Kind>/<name>`. Together with [AnnotationManaged] it marks a Secret as ours to
// update and to remove: the agent never overwrites or deletes any other Secret.
const AnnotationLocation = "vfm.io/location"

const (
	kindBSL = "BackupStorageLocation"
	kindVSL = "VolumeSnapshotLocation"

	// maxCredentialBytes bounds one credential: a cloud key file is a few KiB.
	maxCredentialBytes = 64 * 1024
)

var (
	// secretKey is the character set Kubernetes allows for a key in a Secret's data.
	secretKey = regexp.MustCompile(`^[-._a-zA-Z0-9]{1,253}$`)
	// secretName is a DNS subdomain.
	secretName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)
)

var credentialRefField = field{kind: kObject, fields: map[string]field{"name": {kind: kString}, "key": {kind: kString}}}

// bslSpecShape is Velero v1.18's `BackupStorageLocationSpec`.
var bslSpecShape = map[string]field{
	"provider":   {kind: kString},
	"config":     {kind: kStringMap},
	"credential": credentialRefField,
	"objectStorage": {kind: kObject, fields: map[string]field{
		"bucket": {kind: kString}, "prefix": {kind: kString}, "caCert": {kind: kString}, "caCertRef": credentialRefField,
	}},
	"default":             {kind: kBool},
	"accessMode":          {kind: kString},
	"backupSyncPeriod":    {kind: kDuration},
	"validationFrequency": {kind: kDuration},
}

// vslSpecShape is Velero v1.18's `VolumeSnapshotLocationSpec`.
var vslSpecShape = map[string]field{
	"provider":   {kind: kString},
	"config":     {kind: kStringMap},
	"credential": credentialRefField,
}

var (
	bslKind = specKind{label: kindBSL, shape: bslSpecShape}
	vslKind = specKind{label: kindVSL, shape: vslSpecShape}
)

// StorageHandler implements the backup and snapshot location operations. A credential
// arrives inside the command, is written to a Secret in Velero's namespace, and goes
// no further: it is not logged, not part of any result, not kept by the agent.
type StorageHandler struct {
	BackupHandler
	Kube kubernetes.Interface
}

func secretRef(ref *pb.SecretKeyRef) map[string]any {
	if ref == nil || ref.GetName() == "" {
		return nil
	}
	return map[string]any{"name": ref.GetName(), "key": ref.GetKey()}
}

// BackupLocationSpecMap renders a protobuf BackupStorageLocationSpec as `spec`.
func BackupLocationSpecMap(s *pb.BackupStorageLocationSpec) map[string]any {
	out := map[string]any{"provider": s.GetProvider()}
	if v := s.GetConfig(); len(v) > 0 {
		out["config"] = toAny(v)
	}
	if ref := secretRef(s.GetCredential()); ref != nil {
		out["credential"] = ref
	}
	store := map[string]any{"bucket": s.GetObjectStorage().GetBucket()}
	if v := s.GetObjectStorage().GetPrefix(); v != "" {
		store["prefix"] = v
	}
	if v := s.GetObjectStorage().GetCaCert(); len(v) > 0 {
		// Velero's `caCert` is a []byte, which JSON carries as base64.
		store["caCert"] = base64.StdEncoding.EncodeToString(v)
	}
	if ref := secretRef(s.GetObjectStorage().GetCaCertRef()); ref != nil {
		store["caCertRef"] = ref
	}
	out["objectStorage"] = store
	if s.GetDefault() {
		out["default"] = true
	}
	switch s.GetAccessMode() {
	case pb.BackupStorageLocationAccessMode_BSL_ACCESS_MODE_READ_ONLY:
		out["accessMode"] = "ReadOnly"
	case pb.BackupStorageLocationAccessMode_BSL_ACCESS_MODE_READ_WRITE:
		out["accessMode"] = "ReadWrite"
	}
	duration(out, "backupSyncPeriod", s.GetBackupSyncPeriod())
	duration(out, "validationFrequency", s.GetValidationFrequency())
	return out
}

// SnapshotLocationSpecMap renders a protobuf VolumeSnapshotLocationSpec as `spec`.
func SnapshotLocationSpecMap(s *pb.VolumeSnapshotLocationSpec) map[string]any {
	out := map[string]any{"provider": s.GetProvider()}
	if v := s.GetConfig(); len(v) > 0 {
		out["config"] = toAny(v)
	}
	if ref := secretRef(s.GetCredential()); ref != nil {
		out["credential"] = ref
	}
	return out
}

func noun(kind string) string {
	if kind == kindBSL {
		return "backup storage location"
	}
	return "volume snapshot location"
}

// checkCredential validates a credential before anything is written. Its messages
// never include the content.
func checkCredential(c *pb.CredentialSecret) string {
	ref := c.GetRef()
	switch {
	case ref.GetName() == "" || len(ref.GetName()) > 253 || !secretName.MatchString(ref.GetName()):
		return "credential: the Secret name must be a valid Kubernetes name"
	case !secretKey.MatchString(ref.GetKey()):
		return "credential: the Secret key may contain only letters, digits, '-', '_' and '.'"
	case len(c.GetContent()) == 0:
		return "credential: the content is empty"
	case len(c.GetContent()) > maxCredentialBytes:
		return fmt.Sprintf("credential: the content is larger than %d KiB", maxCredentialBytes/1024)
	}
	return ""
}

// writeSecret creates or updates the Secret that holds a credential. It refuses to
// touch a Secret it did not create: pointing a location at `cloud-credentials` and
// quietly replacing Velero's own credentials would break every other location.
func (h *StorageHandler) writeSecret(ctx context.Context, c *pb.CredentialSecret, owner string) *pb.CommandResult {
	if problem := checkCredential(c); problem != "" {
		return invalid(problem)
	}
	secrets := h.Kube.CoreV1().Secrets(h.Namespace)
	data := map[string][]byte{c.GetRef().GetKey(): c.GetContent()}
	existing, err := secrets.Get(ctx, c.GetRef().GetName(), metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		_, err = secrets.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{
				Name:        c.GetRef().GetName(),
				Namespace:   h.Namespace,
				Annotations: map[string]string{AnnotationManaged: "true", AnnotationLocation: owner},
			},
			Type: corev1.SecretTypeOpaque,
			Data: data,
		}, metav1.CreateOptions{})
	case err == nil:
		if existing.Annotations[AnnotationManaged] != "true" || existing.Annotations[AnnotationLocation] != owner {
			return &pb.CommandResult{
				ErrorCode:    pb.ErrorCode_ERROR_CODE_ALREADY_EXISTS,
				ErrorMessage: "a Secret with that name exists that was not created for this location; reference it instead, or choose another name",
			}
		}
		existing.Data = data
		_, err = secrets.Update(ctx, existing, metav1.UpdateOptions{})
	}
	if err != nil {
		return h.describe(ctx, err, "credential Secret")
	}
	return nil
}

// removeSecret deletes the credential Secret this agent wrote for a location, if
// there is one. Anything else is left alone.
func (h *StorageHandler) removeSecret(ctx context.Context, ref map[string]any, owner string) {
	name, _ := ref["name"].(string)
	if name == "" {
		return
	}
	secrets := h.Kube.CoreV1().Secrets(h.Namespace)
	existing, err := secrets.Get(ctx, name, metav1.GetOptions{})
	if err != nil || existing.Annotations[AnnotationManaged] != "true" || existing.Annotations[AnnotationLocation] != owner {
		return
	}
	_ = secrets.Delete(ctx, name, metav1.DeleteOptions{})
}

// UpsertBackupLocation is a [dispatch.Handler] for UpsertBackupStorageLocation.
func (h *StorageHandler) UpsertBackupLocation(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	req := cmd.GetUpsertBsl()
	if problem := checkName(req.GetName()); problem != "" {
		return invalid(problem)
	}
	if req.GetSpec() == nil || req.GetSpec().GetProvider() == "" {
		return invalid("a provider is required")
	}
	if req.GetSpec().GetObjectStorage().GetBucket() == "" {
		return invalid("a bucket is required")
	}
	if req.GetSpec().GetObjectStorage().GetCaCert() != nil && req.GetSpec().GetObjectStorage().GetCaCertRef() != nil {
		return invalid("give either an inline CA certificate or a reference to one, not both")
	}
	spec := BackupLocationSpecMap(req.GetSpec())
	if c := req.GetCredential(); c != nil {
		// What the Secret holds is what the location is pointed at.
		spec["credential"] = secretRef(c.GetRef())
	}
	if err := validateSpec(bslKind, spec); err != nil {
		return invalid(err.Error())
	}
	owner := kindBSL + "/" + req.GetName()
	if c := req.GetCredential(); c != nil {
		if failure := h.writeSecret(ctx, c, owner); failure != nil {
			return failure
		}
	}
	made, failure := h.upsert(ctx, cmd, backupStorageLocations, kindBSL, req.GetName(), spec)
	if failure != nil {
		return failure
	}
	if req.GetSpec().GetDefault() {
		if failure := h.unsetOtherDefaults(ctx, req.GetName()); failure != nil {
			return failure
		}
	}
	return created(kindBSL, made)
}

// UpsertSnapshotLocation is a [dispatch.Handler] for UpsertVolumeSnapshotLocation.
func (h *StorageHandler) UpsertSnapshotLocation(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	req := cmd.GetUpsertVsl()
	if problem := checkName(req.GetName()); problem != "" {
		return invalid(problem)
	}
	if req.GetSpec() == nil || req.GetSpec().GetProvider() == "" {
		return invalid("a provider is required")
	}
	spec := SnapshotLocationSpecMap(req.GetSpec())
	if c := req.GetCredential(); c != nil {
		spec["credential"] = secretRef(c.GetRef())
	}
	if err := validateSpec(vslKind, spec); err != nil {
		return invalid(err.Error())
	}
	if c := req.GetCredential(); c != nil {
		if failure := h.writeSecret(ctx, c, kindVSL+"/"+req.GetName()); failure != nil {
			return failure
		}
	}
	made, failure := h.upsert(ctx, cmd, volumeSnapshotLocation, kindVSL, req.GetName(), spec)
	if failure != nil {
		return failure
	}
	return created(kindVSL, made)
}

// upsert creates the object, or replaces the spec of the one that exists.
func (h *StorageHandler) upsert(ctx context.Context, cmd *pb.Command, gvr schema.GroupVersionResource, kind, name string, spec map[string]any) (*unstructured.Unstructured, *pb.CommandResult) {
	resource := h.Dynamic.Resource(gvr).Namespace(h.Namespace)
	current, err := resource.Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		obj := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "velero.io/v1",
			"kind":       kind,
			"metadata": map[string]any{
				"name":        name,
				"namespace":   h.Namespace,
				"labels":      toAny(h.stampLabels(cmd, nil)),
				"annotations": map[string]any{AnnotationManaged: "true"},
			},
			"spec": spec,
		}}
		made, err := resource.Create(ctx, obj, metav1.CreateOptions{})
		if err != nil {
			return nil, h.describe(ctx, err, noun(kind))
		}
		return made, nil
	}
	if err != nil {
		return nil, h.describe(ctx, err, noun(kind))
	}
	if err := unstructured.SetNestedField(current.Object, spec, "spec"); err != nil {
		return nil, invalid("the spec could not be set")
	}
	made, err := resource.Update(ctx, current, metav1.UpdateOptions{})
	if err != nil {
		return nil, h.describe(ctx, err, noun(kind))
	}
	return made, nil
}

// unsetOtherDefaults leaves one default location: Velero uses the default when a
// backup names none, and two defaults make that ambiguous.
func (h *StorageHandler) unsetOtherDefaults(ctx context.Context, keep string) *pb.CommandResult {
	resource := h.Dynamic.Resource(backupStorageLocations).Namespace(h.Namespace)
	list, err := resource.List(ctx, metav1.ListOptions{})
	if err != nil {
		return h.describe(ctx, err, "backup storage location")
	}
	off, _ := json.Marshal(map[string]any{"spec": map[string]any{"default": false}})
	for _, item := range list.Items {
		if item.GetName() == keep {
			continue
		}
		if isDefault, _, _ := unstructured.NestedBool(item.Object, "spec", "default"); !isDefault {
			continue
		}
		if _, err := resource.Patch(ctx, item.GetName(), types.MergePatchType, off, metav1.PatchOptions{}); err != nil {
			return h.describe(ctx, err, "backup storage location")
		}
	}
	return nil
}

// SetDefaultBackupLocation is a [dispatch.Handler] for SetDefaultBackupStorageLocation.
func (h *StorageHandler) SetDefaultBackupLocation(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	name := cmd.GetSetDefaultBsl().GetName()
	if problem := checkName(name); problem != "" {
		return invalid(problem)
	}
	resource := h.Dynamic.Resource(backupStorageLocations).Namespace(h.Namespace)
	on, _ := json.Marshal(map[string]any{"spec": map[string]any{"default": true}})
	made, err := resource.Patch(ctx, name, types.MergePatchType, on, metav1.PatchOptions{})
	if err != nil {
		return h.describe(ctx, err, "backup storage location")
	}
	if failure := h.unsetOtherDefaults(ctx, name); failure != nil {
		return failure
	}
	return created(kindBSL, made)
}

// DeleteBackupLocation is a [dispatch.Handler] for DeleteBackupStorageLocation. The
// bucket and what is in it are not touched.
func (h *StorageHandler) DeleteBackupLocation(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	return h.deleteLocation(ctx, backupStorageLocations, kindBSL, cmd.GetDeleteBsl().GetName())
}

// DeleteSnapshotLocation is a [dispatch.Handler] for DeleteVolumeSnapshotLocation.
func (h *StorageHandler) DeleteSnapshotLocation(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	return h.deleteLocation(ctx, volumeSnapshotLocation, kindVSL, cmd.GetDeleteVsl().GetName())
}

func (h *StorageHandler) deleteLocation(ctx context.Context, gvr schema.GroupVersionResource, kind, name string) *pb.CommandResult {
	if problem := checkName(name); problem != "" {
		return invalid(problem)
	}
	resource := h.Dynamic.Resource(gvr).Namespace(h.Namespace)
	current, err := resource.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return h.describe(ctx, err, noun(kind))
	}
	if err := resource.Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		return h.describe(ctx, err, noun(kind))
	}
	ref, _, _ := unstructured.NestedMap(current.Object, "spec", "credential")
	h.removeSecret(ctx, ref, kind+"/"+name)
	return &pb.CommandResult{Ok: true, Detail: &pb.CommandResult_Created{Created: &pb.CreatedObject{
		Kind: "Deleted" + kind, Name: name, Uid: string(current.GetUID()),
	}}}
}
