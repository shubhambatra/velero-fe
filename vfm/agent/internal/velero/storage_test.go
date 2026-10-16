package velero

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubefake "k8s.io/client-go/kubernetes/fake"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// marker is the credential content in these tests; it must appear in the Secret and nowhere else.
const marker = "AKIA-TEST-MARKER-do-not-leak"

func storageClient(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			backupStorageLocations: "BackupStorageLocationList", volumeSnapshotLocation: "VolumeSnapshotLocationList",
		}, objs...)
}

func storageHandler(c *dynamicfake.FakeDynamicClient, k *kubefake.Clientset) *StorageHandler {
	return &StorageHandler{BackupHandler: *backupHandler(c), Kube: k}
}

func bslSpec() *pb.BackupStorageLocationSpec {
	return &pb.BackupStorageLocationSpec{
		Provider:      "aws",
		Config:        map[string]string{"region": "eu-west-1"},
		ObjectStorage: &pb.ObjectStorageLocation{Bucket: "backups", Prefix: "prod"},
		AccessMode:    pb.BackupStorageLocationAccessMode_BSL_ACCESS_MODE_READ_WRITE,
	}
}

func credential(name string) *pb.CredentialSecret {
	return &pb.CredentialSecret{Ref: &pb.SecretKeyRef{Name: name, Key: "cloud"}, Content: []byte(marker)}
}

func upsertBSL(name string, spec *pb.BackupStorageLocationSpec, c *pb.CredentialSecret) *pb.Command {
	return &pb.Command{CommandId: cmdID, Op: &pb.Command_UpsertBsl{UpsertBsl: &pb.UpsertBackupStorageLocation{
		Name: name, Spec: spec, Credential: c}}}
}

func getLocation(t *testing.T, c *dynamicfake.FakeDynamicClient, gvr schema.GroupVersionResource, name string) *unstructured.Unstructured {
	t.Helper()
	obj, err := c.Resource(gvr).Namespace("velero").Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return obj
}

func TestUpsertBackupLocationWritesTheSecretAndReferencesIt(t *testing.T) {
	c, k := storageClient(), kubefake.NewClientset()
	spec := bslSpec()
	spec.BackupSyncPeriod = durationpb.New(2 * time.Minute)
	res := storageHandler(c, k).UpsertBackupLocation(context.Background(), upsertBSL("primary", spec, credential("vfm-bsl-primary")))
	if !res.Ok || res.GetCreated().GetKind() != "BackupStorageLocation" {
		t.Fatalf("not created: %+v", res)
	}

	obj := getLocation(t, c, backupStorageLocations, "primary")
	got := obj.Object["spec"].(map[string]any)
	store := got["objectStorage"].(map[string]any)
	ref := got["credential"].(map[string]any)
	if got["provider"] != "aws" || store["bucket"] != "backups" || store["prefix"] != "prod" ||
		got["accessMode"] != "ReadWrite" || got["backupSyncPeriod"] != "2m0s" ||
		ref["name"] != "vfm-bsl-primary" || ref["key"] != "cloud" {
		t.Errorf("spec = %v", got)
	}
	if obj.GetAnnotations()[AnnotationManaged] != "true" {
		t.Errorf("not stamped: %v", obj.GetAnnotations())
	}

	secret, err := k.CoreV1().Secrets("velero").Get(context.Background(), "vfm-bsl-primary", metav1.GetOptions{})
	if err != nil || string(secret.Data["cloud"]) != marker ||
		secret.Annotations[AnnotationManaged] != "true" || secret.Annotations[AnnotationLocation] != "BackupStorageLocation/primary" {
		t.Fatalf("secret = %+v %v", secret, err)
	}
	if strings.Contains(strings.ToLower(toString(t, obj.Object)), strings.ToLower(marker)) {
		t.Error("the credential reached the Velero object")
	}
}

func toString(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestUpsertBackupLocationUpdatesAndRotatesTheCredential(t *testing.T) {
	c, k := storageClient(), kubefake.NewClientset()
	h := storageHandler(c, k)
	h.UpsertBackupLocation(context.Background(), upsertBSL("primary", bslSpec(), credential("vfm-bsl-primary")))

	changed := bslSpec()
	changed.ObjectStorage.Bucket = "other"
	rotated := credential("vfm-bsl-primary")
	rotated.Content = []byte("rotated")
	if res := h.UpsertBackupLocation(context.Background(), upsertBSL("primary", changed, rotated)); !res.Ok {
		t.Fatalf("update failed: %+v", res)
	}
	store := getLocation(t, c, backupStorageLocations, "primary").Object["spec"].(map[string]any)["objectStorage"].(map[string]any)
	if store["bucket"] != "other" {
		t.Errorf("bucket = %v", store["bucket"])
	}
	secret, _ := k.CoreV1().Secrets("velero").Get(context.Background(), "vfm-bsl-primary", metav1.GetOptions{})
	if string(secret.Data["cloud"]) != "rotated" {
		t.Errorf("the credential was not rotated: %q", secret.Data["cloud"])
	}
}

func TestUpsertWithoutACredentialKeepsTheReferenceAndTouchesNoSecret(t *testing.T) {
	c, k := storageClient(), kubefake.NewClientset()
	spec := bslSpec()
	spec.Credential = &pb.SecretKeyRef{Name: "cloud-credentials", Key: "cloud"}
	res := storageHandler(c, k).UpsertBackupLocation(context.Background(), upsertBSL("primary", spec, nil))
	if !res.Ok {
		t.Fatalf("%+v", res)
	}
	ref := getLocation(t, c, backupStorageLocations, "primary").Object["spec"].(map[string]any)["credential"].(map[string]any)
	if ref["name"] != "cloud-credentials" {
		t.Errorf("ref = %v", ref)
	}
	if secrets, _ := k.CoreV1().Secrets("velero").List(context.Background(), metav1.ListOptions{}); len(secrets.Items) != 0 {
		t.Error("a Secret was written without a credential")
	}
}

func TestACredentialNeverOverwritesASecretWeDidNotWrite(t *testing.T) {
	c := storageClient()
	k := kubefake.NewClientset(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "cloud-credentials", Namespace: "velero"},
		Data:       map[string][]byte{"cloud": []byte("velero's own")},
	})
	res := storageHandler(c, k).UpsertBackupLocation(context.Background(), upsertBSL("primary", bslSpec(), credential("cloud-credentials")))
	if res.Ok || res.ErrorCode != pb.ErrorCode_ERROR_CODE_ALREADY_EXISTS {
		t.Fatalf("overwrote a foreign Secret: %+v", res)
	}
	secret, _ := k.CoreV1().Secrets("velero").Get(context.Background(), "cloud-credentials", metav1.GetOptions{})
	if string(secret.Data["cloud"]) != "velero's own" {
		t.Error("the foreign Secret was changed")
	}
	if count(t, c, backupStorageLocations) != 0 {
		t.Error("a location was created pointing at a Secret that was refused")
	}
	if strings.Contains(res.ErrorMessage, marker) {
		t.Error("the error carries the credential")
	}
}

func TestAnotherLocationsSecretIsNotOverwrittenEither(t *testing.T) {
	c, k := storageClient(), kubefake.NewClientset()
	h := storageHandler(c, k)
	h.UpsertBackupLocation(context.Background(), upsertBSL("one", bslSpec(), credential("shared")))
	res := h.UpsertBackupLocation(context.Background(), upsertBSL("two", bslSpec(), credential("shared")))
	if res.Ok {
		t.Fatal("a second location took over the first one's Secret")
	}
}

func TestUpsertRefusesWhatVeleroWouldReject(t *testing.T) {
	huge := credential("s")
	huge.Content = bytes.Repeat([]byte("x"), maxCredentialBytes+1)
	noKey := credential("s")
	noKey.Ref.Key = "bad key"
	badSpec := func(f func(*pb.BackupStorageLocationSpec)) *pb.BackupStorageLocationSpec {
		s := bslSpec()
		f(s)
		return s
	}
	for name, cmd := range map[string]*pb.Command{
		"bad name":    upsertBSL("A_B", bslSpec(), nil),
		"no provider": upsertBSL("a", badSpec(func(s *pb.BackupStorageLocationSpec) { s.Provider = "" }), nil),
		"no bucket":   upsertBSL("a", badSpec(func(s *pb.BackupStorageLocationSpec) { s.ObjectStorage.Bucket = "" }), nil),
		"both CA forms": upsertBSL("a", badSpec(func(s *pb.BackupStorageLocationSpec) {
			s.ObjectStorage.CaCert = []byte("pem")
			s.ObjectStorage.CaCertRef = &pb.SecretKeyRef{Name: "ca", Key: "ca.crt"}
		}), nil),
		"empty credential": upsertBSL("a", bslSpec(), &pb.CredentialSecret{Ref: &pb.SecretKeyRef{Name: "s", Key: "cloud"}}),
		"huge credential":  upsertBSL("a", bslSpec(), huge),
		"bad secret key":   upsertBSL("a", bslSpec(), noKey),
		"bad secret name":  upsertBSL("a", bslSpec(), credential("Not_Valid")),
	} {
		c, k := storageClient(), kubefake.NewClientset()
		res := storageHandler(c, k).UpsertBackupLocation(context.Background(), cmd)
		if res.Ok || res.ErrorCode != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
			t.Errorf("%s: accepted or wrong code: %+v", name, res)
		}
		if count(t, c, backupStorageLocations) != 0 {
			t.Errorf("%s: a location was created", name)
		}
	}
}

func TestOnlyOneBackupLocationIsTheDefault(t *testing.T) {
	c, k := storageClient(), kubefake.NewClientset()
	h := storageHandler(c, k)
	first := bslSpec()
	first.Default = true
	h.UpsertBackupLocation(context.Background(), upsertBSL("one", first, nil))
	h.UpsertBackupLocation(context.Background(), upsertBSL("two", bslSpec(), nil))

	isDefault := func(name string) bool {
		v, _, _ := unstructured.NestedBool(getLocation(t, c, backupStorageLocations, name).Object, "spec", "default")
		return v
	}
	if !isDefault("one") || isDefault("two") {
		t.Fatalf("defaults: one=%v two=%v", isDefault("one"), isDefault("two"))
	}
	res := h.SetDefaultBackupLocation(context.Background(), &pb.Command{CommandId: cmdID,
		Op: &pb.Command_SetDefaultBsl{SetDefaultBsl: &pb.SetDefaultBackupStorageLocation{Name: "two"}}})
	if !res.Ok || isDefault("one") || !isDefault("two") {
		t.Fatalf("default not moved: %+v one=%v two=%v", res, isDefault("one"), isDefault("two"))
	}

	missing := h.SetDefaultBackupLocation(context.Background(), &pb.Command{CommandId: cmdID,
		Op: &pb.Command_SetDefaultBsl{SetDefaultBsl: &pb.SetDefaultBackupStorageLocation{Name: "nope"}}})
	if missing.Ok || missing.ErrorCode != pb.ErrorCode_ERROR_CODE_NOT_FOUND || !isDefault("two") {
		t.Errorf("a missing location must change nothing: %+v", missing)
	}
}

func TestDeleteEmptiesOnlyTheSecretWeWrote(t *testing.T) {
	c := storageClient()
	k := kubefake.NewClientset(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "cloud-credentials", Namespace: "velero"},
		Data:       map[string][]byte{"cloud": []byte("velero's own")},
	})
	h := storageHandler(c, k)
	h.UpsertBackupLocation(context.Background(), upsertBSL("ours", bslSpec(), credential("vfm-bsl-ours")))
	theirs := bslSpec()
	theirs.Credential = &pb.SecretKeyRef{Name: "cloud-credentials", Key: "cloud"}
	h.UpsertBackupLocation(context.Background(), upsertBSL("theirs", theirs, nil))

	del := func(name string) *pb.CommandResult {
		return h.DeleteBackupLocation(context.Background(), &pb.Command{CommandId: cmdID,
			Op: &pb.Command_DeleteBsl{DeleteBsl: &pb.DeleteBackupStorageLocation{Name: name}}})
	}
	if res := del("ours"); !res.Ok || res.GetCreated().GetKind() != "DeletedBackupStorageLocation" {
		t.Fatalf("%+v", res)
	}
	if res := del("theirs"); !res.Ok {
		t.Fatalf("%+v", res)
	}
	if ours, err := k.CoreV1().Secrets("velero").Get(context.Background(), "vfm-bsl-ours", metav1.GetOptions{}); err != nil || len(ours.Data) != 0 {
		t.Errorf("the Secret we wrote must be emptied: %+v %v", ours, err)
	}
	if theirs, err := k.CoreV1().Secrets("velero").Get(context.Background(), "cloud-credentials", metav1.GetOptions{}); err != nil || string(theirs.Data["cloud"]) != "velero's own" {
		t.Error("a Secret we did not write was changed")
	}
	if count(t, c, backupStorageLocations) != 0 {
		t.Error("locations remain")
	}
	if res := del("ours"); res.Ok || res.ErrorCode != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Errorf("deleting twice: %+v", res)
	}
}

func TestSnapshotLocationsUpsertAndDelete(t *testing.T) {
	c, k := storageClient(), kubefake.NewClientset()
	h := storageHandler(c, k)
	res := h.UpsertSnapshotLocation(context.Background(), &pb.Command{CommandId: cmdID,
		Op: &pb.Command_UpsertVsl{UpsertVsl: &pb.UpsertVolumeSnapshotLocation{
			Name: "snaps", Spec: &pb.VolumeSnapshotLocationSpec{Provider: "aws", Config: map[string]string{"region": "eu-west-1"}},
			Credential: credential("vfm-vsl-snaps")}}})
	if !res.Ok || res.GetCreated().GetKind() != "VolumeSnapshotLocation" {
		t.Fatalf("%+v", res)
	}
	spec := getLocation(t, c, volumeSnapshotLocation, "snaps").Object["spec"].(map[string]any)
	if spec["provider"] != "aws" || spec["credential"].(map[string]any)["name"] != "vfm-vsl-snaps" {
		t.Errorf("spec = %v", spec)
	}
	secret, err := k.CoreV1().Secrets("velero").Get(context.Background(), "vfm-vsl-snaps", metav1.GetOptions{})
	if err != nil || secret.Annotations[AnnotationLocation] != "VolumeSnapshotLocation/snaps" {
		t.Fatalf("secret = %+v %v", secret, err)
	}
	del := h.DeleteSnapshotLocation(context.Background(), &pb.Command{CommandId: cmdID,
		Op: &pb.Command_DeleteVsl{DeleteVsl: &pb.DeleteVolumeSnapshotLocation{Name: "snaps"}}})
	if !del.Ok || count(t, c, volumeSnapshotLocation) != 0 {
		t.Fatalf("%+v", del)
	}
	if left, err := k.CoreV1().Secrets("velero").Get(context.Background(), "vfm-vsl-snaps", metav1.GetOptions{}); err != nil || len(left.Data) != 0 {
		t.Errorf("the Secret must be emptied: %+v %v", left, err)
	}
}

func TestNoResultOrErrorEverCarriesTheCredential(t *testing.T) {
	c, k := storageClient(), kubefake.NewClientset()
	h := storageHandler(c, k)
	var out []string
	for _, cmd := range []*pb.Command{
		upsertBSL("primary", bslSpec(), credential("vfm-bsl-primary")),
		upsertBSL("primary", bslSpec(), credential("vfm-bsl-primary")),
		upsertBSL("bad name!", bslSpec(), credential("vfm-bsl-primary")),
		upsertBSL("x", bslSpec(), credential("Bad_Name")),
	} {
		res := h.UpsertBackupLocation(context.Background(), cmd)
		out = append(out, res.String())
	}
	if strings.Contains(strings.Join(out, "\n"), marker) {
		t.Errorf("a result carries the credential: %v", out)
	}
}
