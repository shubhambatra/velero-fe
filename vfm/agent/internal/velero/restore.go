package velero

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

var restores = schema.GroupVersionResource{Group: "velero.io", Version: "v1", Resource: "restores"}

// RestoreHandler implements `CreateRestore` and `DeleteRestore`.
//
// A restore writes into the cluster, so besides the policy check the dispatcher
// makes on the typed command, the handler checks the spec **as it will be created**
// — after the advanced settings are merged on — against the owner's policy. Without
// that, `advanced_spec_json` could name a protected namespace that the typed fields
// were never allowed to.
type RestoreHandler struct {
	BackupHandler
	// Policy returns the policy in effect. Required: a restore is never made without it.
	Policy func() policy.Policy
}

// Create is a [dispatch.Handler] for CreateRestore.
func (h *RestoreHandler) Create(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	req := cmd.GetCreateRestore()
	if name := req.GetName(); name != "" {
		if problem := checkName(name); problem != "" {
			return invalid(problem)
		}
	}
	spec, err := ApplyAdvancedRestore(RestoreSpecMap(req.GetSpec()), req.GetAdvancedSpecJson())
	if err != nil {
		return invalid(err.Error())
	}

	backup, _ := spec["backupName"].(string)
	schedule, _ := spec["scheduleName"].(string)
	if (backup == "") == (schedule == "") {
		return invalid("name exactly one of a backup and a schedule to restore from")
	}
	switch spec["existingResourcePolicy"] {
	case nil, "", "none", "update":
	default:
		return invalid(`existingResourcePolicy must be "none" or "update"`)
	}

	if h.Policy == nil {
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_INTERNAL, ErrorMessage: "the agent has no policy to check the restore against"}
	}
	var includeCluster *bool
	if v, ok := spec["includeClusterResources"].(bool); ok {
		includeCluster = &v
	}
	if denial := h.Policy().CheckRestoreClusterScope(includeCluster); denial != nil {
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY, ErrorMessage: denial.Reason}
	}
	if denial := h.Policy().CheckRestoreScope(stringsOf(spec["includedNamespaces"]), stringsOf(spec["excludedNamespaces"]), stringMap(spec["namespaceMapping"])); denial != nil {
		return &pb.CommandResult{ErrorCode: pb.ErrorCode_ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY, ErrorMessage: denial.Reason}
	}

	resource := h.Dynamic.Resource(restores).Namespace(h.Namespace)
	if existing, err := h.findByCommand(ctx, resource, cmd); err != nil {
		return h.describe(ctx, err, "restore")
	} else if existing != nil {
		return created("Restore", existing)
	}

	// The source must exist: say so now rather than leave a restore that fails validation.
	if backup != "" {
		if _, err := h.Dynamic.Resource(backups).Namespace(h.Namespace).Get(ctx, backup, metav1.GetOptions{}); err != nil {
			return h.describe(ctx, err, "backup")
		}
	} else if _, err := h.Dynamic.Resource(schedules).Namespace(h.Namespace).Get(ctx, schedule, metav1.GetOptions{}); err != nil {
		return h.describe(ctx, err, "schedule")
	}

	name := req.GetName()
	if name == "" {
		source := backup
		if source == "" {
			source = schedule
		}
		stamp := h.now().Format("20060102150405")
		name = trimName(source, maxNameLength-1-len(stamp)) + "-" + stamp
	}

	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1",
		"kind":       "Restore",
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
		return h.describe(ctx, err, "restore")
	}
	return created("Restore", made)
}

// Delete is a [dispatch.Handler] for DeleteRestore. Velero deletes a restore by
// deleting the Restore object; the restored resources stay where they are.
func (h *RestoreHandler) Delete(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	name := cmd.GetDeleteRestore().GetName()
	if problem := checkName(name); problem != "" {
		return invalid(problem)
	}
	resource := h.Dynamic.Resource(restores).Namespace(h.Namespace)
	restore, err := resource.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return h.describe(ctx, err, "restore")
	}
	if err := resource.Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		return h.describe(ctx, err, "restore")
	}
	return &pb.CommandResult{Ok: true, Detail: &pb.CommandResult_Created{Created: &pb.CreatedObject{
		Kind: "DeletedRestore", Name: name, Uid: string(restore.GetUID()),
	}}}
}

func stringsOf(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func stringMap(v any) map[string]string {
	m, _ := v.(map[string]any)
	out := make(map[string]string, len(m))
	for k, item := range m {
		if s, ok := item.(string); ok {
			out[k] = s
		}
	}
	return out
}
