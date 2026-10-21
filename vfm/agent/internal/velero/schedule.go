package velero

import (
	"context"
	"encoding/json"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// scheduleSpecShape is Velero v1.18's `ScheduleSpec`; the template is a BackupSpec.
var scheduleSpecShape = map[string]field{
	"template":                   {kind: kObject, fields: backupSpecShape},
	"schedule":                   {kind: kString},
	"useOwnerReferencesInBackup": {kind: kBool},
	"paused":                     {kind: kBool},
	"skipImmediately":            {kind: kBool},
}

var scheduleKind = specKind{label: "Schedule", shape: scheduleSpecShape}

// ScheduleSpecMap renders a protobuf ScheduleSpec in the shape of `Schedule.spec`.
func ScheduleSpecMap(s *pb.ScheduleSpec) map[string]any {
	out := map[string]any{"template": BackupSpecMap(s.GetTemplate()), "schedule": s.GetSchedule()}
	if s.UseOwnerReferencesInBackup != nil {
		out["useOwnerReferencesInBackup"] = s.GetUseOwnerReferencesInBackup()
	}
	if s.GetPaused() {
		out["paused"] = true
	}
	if s.SkipImmediately != nil {
		out["skipImmediately"] = s.GetSkipImmediately()
	}
	return out
}

// buildScheduleSpec turns a command's typed spec and advanced settings into the
// object spec. The advanced settings are those of the backup template: they are
// merged onto it, then the whole spec is checked against Velero's shape.
func buildScheduleSpec(s *pb.ScheduleSpec, advanced []byte) (map[string]any, error) {
	spec := ScheduleSpecMap(s)
	template, _ := spec["template"].(map[string]any)
	merged, err := ApplyAdvanced(template, advanced)
	if err != nil {
		return nil, err
	}
	spec["template"] = merged
	if err := ValidateCron(s.GetSchedule()); err != nil {
		return nil, &ErrInvalidSpec{Problems: []string{"schedule: " + err.Error()}}
	}
	if err := validateSpec(scheduleKind, spec); err != nil {
		return nil, err
	}
	return spec, nil
}

// ScheduleHandler implements the schedule operations: create, update, pause or
// resume, and delete. Run-now is [BackupHandler.TriggerSchedule].
type ScheduleHandler struct {
	BackupHandler
}

// Create is a [dispatch.Handler] for CreateSchedule.
func (h *ScheduleHandler) Create(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	req := cmd.GetCreateSchedule()
	if problem := checkName(req.GetName()); problem != "" {
		return invalid(problem)
	}
	spec, err := buildScheduleSpec(req.GetSpec(), req.GetAdvancedSpecJson())
	if err != nil {
		return invalid(err.Error())
	}
	resource := h.Dynamic.Resource(schedules).Namespace(h.Namespace)
	if existing, err := h.findByCommand(ctx, resource, cmd); err != nil {
		return h.describe(ctx, err, "schedule")
	} else if existing != nil {
		return created("Schedule", existing)
	}
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1",
		"kind":       "Schedule",
		"metadata": map[string]any{
			"name":        req.GetName(),
			"namespace":   h.Namespace,
			"labels":      toAny(h.stampLabels(cmd, nil)),
			"annotations": map[string]any{AnnotationManaged: "true"},
		},
		"spec": spec,
	}}
	made, err := resource.Create(ctx, obj, metav1.CreateOptions{})
	if err != nil {
		return h.describe(ctx, err, "schedule")
	}
	return created("Schedule", made)
}

// Update is a [dispatch.Handler] for UpdateSchedule: the spec is replaced as a whole,
// so what the form shows is what the schedule becomes. The command id is not stamped
// on the object (it names the creating command); a re-delivered update is harmless
// because replacing a spec with itself changes nothing.
func (h *ScheduleHandler) Update(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	req := cmd.GetUpdateSchedule()
	if problem := checkName(req.GetName()); problem != "" {
		return invalid(problem)
	}
	spec, err := buildScheduleSpec(req.GetSpec(), req.GetAdvancedSpecJson())
	if err != nil {
		return invalid(err.Error())
	}
	resource := h.Dynamic.Resource(schedules).Namespace(h.Namespace)
	current, err := resource.Get(ctx, req.GetName(), metav1.GetOptions{})
	if err != nil {
		return h.describe(ctx, err, "schedule")
	}
	// The form cannot express hooks (they need `advanced:write`), so an update that does
	// not mention them leaves the ones already on the template alone instead of dropping
	// what an administrator put there.
	if old, _, _ := unstructured.NestedMap(current.Object, "spec", "template"); old != nil {
		if hooks, ok := old["hooks"]; ok {
			if tpl, _ := spec["template"].(map[string]any); tpl != nil {
				if _, set := tpl["hooks"]; !set {
					tpl["hooks"] = hooks
				}
			}
		}
	}
	if err := unstructured.SetNestedField(current.Object, spec, "spec"); err != nil {
		return invalid("the spec could not be set")
	}
	made, err := resource.Update(ctx, current, metav1.UpdateOptions{})
	if err != nil {
		return h.describe(ctx, err, "schedule")
	}
	return created("Schedule", made)
}

// SetPaused is a [dispatch.Handler] for SetSchedulePaused.
func (h *ScheduleHandler) SetPaused(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	req := cmd.GetSetSchedulePaused()
	if problem := checkName(req.GetName()); problem != "" {
		return invalid(problem)
	}
	patch, err := json.Marshal(map[string]any{"spec": map[string]any{"paused": req.GetPaused()}})
	if err != nil {
		return invalid(fmt.Sprint(err))
	}
	made, err := h.Dynamic.Resource(schedules).Namespace(h.Namespace).
		Patch(ctx, req.GetName(), types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		return h.describe(ctx, err, "schedule")
	}
	return created("Schedule", made)
}

// Delete is a [dispatch.Handler] for DeleteSchedule. The schedule stops; the backups
// it made stay, as they do with `velero schedule delete`.
func (h *ScheduleHandler) Delete(ctx context.Context, cmd *pb.Command) *pb.CommandResult {
	name := cmd.GetDeleteSchedule().GetName()
	if problem := checkName(name); problem != "" {
		return invalid(problem)
	}
	resource := h.Dynamic.Resource(schedules).Namespace(h.Namespace)
	current, err := resource.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return h.describe(ctx, err, "schedule")
	}
	if err := resource.Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		return h.describe(ctx, err, "schedule")
	}
	return &pb.CommandResult{Ok: true, Detail: &pb.CommandResult_Created{Created: &pb.CreatedObject{
		Kind: "DeletedSchedule", Name: name, Uid: string(current.GetUID()),
	}}}
}
