package velero

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/dispatch"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

var (
	backups = schema.GroupVersionResource{Group: "velero.io", Version: "v1", Resource: "backups"}
	// schedules, deleteBackupRequests: see the Velero API.
	schedules            = schema.GroupVersionResource{Group: "velero.io", Version: "v1", Resource: "schedules"}
	deleteBackupRequests = schema.GroupVersionResource{Group: "velero.io", Version: "v1", Resource: "deletebackuprequests"}
)

// Labels Velero itself puts on the objects the CLI creates.
const (
	LabelScheduleName = "velero.io/schedule-name"
	LabelBackupName   = "velero.io/backup-name"
	LabelBackupUID    = "velero.io/backup-uid"
)

// maxNameLength: a backup's name becomes a label value (`velero.io/backup-name`),
// which Kubernetes limits to 63 characters.
const maxNameLength = 63

var objectName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)

// dnsLabel matches a namespace name.
func dnsLabel() *regexp.Regexp {
	return regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
}

// BackupHandler implements `CreateBackup`, `DeleteBackup` and `TriggerScheduleNow`.
// Everything it creates carries the command id, so a re-delivered command finds
// its object instead of making a second one (PLAN.md §5.4).
type BackupHandler struct {
	Dynamic   dynamic.Interface
	Namespace string
	Now       func() time.Time
}

func (h *BackupHandler) now() time.Time {
	if h.Now != nil {
		return h.Now().UTC()
	}
	return time.Now().UTC()
}

// Create is a [dispatch.Handler] for CreateBackup.
func (h *BackupHandler) Create(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	req := cmd.GetCreateBackup()
	name := req.GetName()
	if name == "" {
		name = "backup-" + h.now().Format("20060102150405")
	}
	if problem := checkName(name); problem != "" {
		return invalid(problem)
	}
	spec, err := ApplyAdvanced(BackupSpecMap(req.GetSpec()), req.GetAdvancedSpecJson())
	if err != nil {
		return invalid(err.Error())
	}
	return h.createBackup(ctx, cmd, name, spec, nil)
}

// TriggerSchedule is a [dispatch.Handler] for TriggerScheduleNow: a backup made
// from the schedule's template, as the schedule controller would make it.
func (h *BackupHandler) TriggerSchedule(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	req := cmd.GetTriggerSchedule()
	if problem := checkName(req.GetScheduleName()); problem != "" {
		return invalid("schedule name: " + problem)
	}
	schedule, err := h.Dynamic.Resource(schedules).Namespace(h.Namespace).Get(ctx, req.GetScheduleName(), metav1.GetOptions{})
	if err != nil {
		return h.describe(ctx, err, "schedule")
	}
	template, _, _ := unstructured.NestedMap(schedule.Object, "spec", "template")
	if template == nil {
		return invalid("the schedule has no backup template")
	}
	name := req.GetBackupName()
	if name == "" {
		name = req.GetScheduleName() + "-" + h.now().Format("20060102150405")
	}
	if problem := checkName(name); problem != "" {
		return invalid(problem)
	}
	extra := map[string]string{LabelScheduleName: req.GetScheduleName()}
	return h.createBackup(ctx, cmd, name, template, extra)
}

func checkName(name string) string {
	switch {
	case name == "":
		return "a name is required"
	case len(name) > maxNameLength:
		return fmt.Sprintf("the name is longer than %d characters", maxNameLength)
	case !objectName.MatchString(name):
		return "the name may contain only lower-case letters, digits, '-' and '.', and must start and end with a letter or digit"
	}
	return ""
}

func (h *BackupHandler) createBackup(ctx context.Context, cmd *pb.Command, name string, spec map[string]any, extraLabels map[string]string) *pb.CommandResult {
	resource := h.Dynamic.Resource(backups).Namespace(h.Namespace)
	if existing, err := h.findByCommand(ctx, resource, cmd); err != nil {
		return h.describe(ctx, err, "backup")
	} else if existing != nil {
		return created("Backup", existing)
	}

	labels := h.stampLabels(cmd, extraLabels)
	// Labels the spec asks Velero to put on its objects stay in spec.metadata.labels;
	// the object's own labels are ours.
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1",
		"kind":       "Backup",
		"metadata": map[string]any{
			"name":        name,
			"namespace":   h.Namespace,
			"labels":      toAny(labels),
			"annotations": map[string]any{AnnotationManaged: "true"},
		},
		"spec": spec,
	}}
	made, err := resource.Create(ctx, obj, metav1.CreateOptions{})
	if err != nil {
		return h.describe(ctx, err, "backup")
	}
	return created("Backup", made)
}

func (h *BackupHandler) stampLabels(cmd *pb.Command, extra map[string]string) map[string]string {
	labels := map[string]string{LabelCommandID: cmd.GetCommandId()}
	if by := cmd.GetRequestedBy(); by != "" && labelValue.MatchString(by) {
		labels[LabelRequestedBy] = by
	}
	for k, v := range extra {
		labels[k] = v
	}
	return labels
}

func (h *BackupHandler) findByCommand(ctx context.Context, resource dynamic.ResourceInterface, cmd *pb.Command) (*unstructured.Unstructured, error) {
	list, err := resource.List(ctx, metav1.ListOptions{LabelSelector: LabelCommandID + "=" + cmd.GetCommandId()})
	if err != nil {
		return nil, err
	}
	if len(list.Items) == 0 {
		return nil, nil
	}
	return &list.Items[0], nil
}

func created(kind string, obj *unstructured.Unstructured) *pb.CommandResult {
	return &pb.CommandResult{Ok: true, Detail: &pb.CommandResult_Created{Created: &pb.CreatedObject{
		Kind: kind, Name: obj.GetName(), Uid: string(obj.GetUID()),
	}}}
}

// Delete is a [dispatch.Handler] for DeleteBackup. Velero deletes a backup, its
// data in object storage and its snapshots, only through a DeleteBackupRequest;
// deleting the Backup object would leave the data behind.
func (h *BackupHandler) Delete(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	name := cmd.GetDeleteBackup().GetName()
	if problem := checkName(name); problem != "" {
		return invalid(problem)
	}
	requests := h.Dynamic.Resource(deleteBackupRequests).Namespace(h.Namespace)
	if existing, err := h.findByCommand(ctx, requests, cmd); err != nil {
		return h.describe(ctx, err, "backup")
	} else if existing != nil {
		return created("DeleteBackupRequest", existing)
	}

	backup, err := h.Dynamic.Resource(backups).Namespace(h.Namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return h.describe(ctx, err, "backup")
	}
	labels := h.stampLabels(cmd, map[string]string{LabelBackupName: name, LabelBackupUID: string(backup.GetUID())})
	// The same naming the CLI uses: the backup's name and a short unique suffix.
	suffix := strings.ReplaceAll(cmd.GetCommandId(), "-", "")
	suffix = suffix[:min(8, len(suffix))]
	request := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1",
		"kind":       "DeleteBackupRequest",
		"metadata": map[string]any{
			"name":        trimName(name, 63-1-len(suffix)) + "-" + suffix,
			"namespace":   h.Namespace,
			"labels":      toAny(labels),
			"annotations": map[string]any{AnnotationManaged: "true"},
		},
		"spec": map[string]any{"backupName": name},
	}}
	made, err := requests.Create(ctx, request, metav1.CreateOptions{})
	if err != nil {
		return h.describe(ctx, err, "backup")
	}
	return created("DeleteBackupRequest", made)
}

func trimName(name string, max int) string {
	if len(name) > max {
		return strings.TrimRight(name[:max], "-.")
	}
	return name
}

// describe turns a Kubernetes error into a typed result, without the raw API
// body (it can name objects or carry details the control plane has no use for).
func (h *BackupHandler) describe(ctx context.Context, err error, what string) *pb.CommandResult {
	switch {
	case ctx.Err() != nil:
		return dispatch.ContextFailure(ctx)
	case apierrors.IsAlreadyExists(err):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_ALREADY_EXISTS, ErrorMessage: "an object with this name already exists"}
	case apierrors.IsNotFound(err):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_NOT_FOUND, ErrorMessage: fmt.Sprintf("the %s was not found", what)}
	case meta.IsNoMatchError(err):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_NOT_FOUND,
			ErrorMessage: fmt.Sprintf("Velero's resources were not found; is Velero installed in namespace %q?", h.Namespace)}
	case apierrors.IsInvalid(err), apierrors.IsBadRequest(err):
		return invalid("Kubernetes refused the object as invalid")
	case apierrors.IsForbidden(err):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR, ErrorMessage: "the agent is not permitted to manage this Velero resource"}
	case errors.Is(err, context.DeadlineExceeded):
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_TIMEOUT, ErrorMessage: "the Kubernetes API did not answer in time"}
	default:
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR, ErrorMessage: "the Kubernetes API returned an error"}
	}
}
