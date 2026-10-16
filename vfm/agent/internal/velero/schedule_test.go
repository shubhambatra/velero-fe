package velero

import (
	"context"
	"strings"
	"testing"

	"google.golang.org/protobuf/types/known/durationpb"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

func scheduleHandler(c *dynamicfake.FakeDynamicClient) *ScheduleHandler {
	return &ScheduleHandler{BackupHandler: *backupHandler(c)}
}

func scheduleCmd(name, cron string, template *pb.BackupSpec, advanced string) *pb.Command {
	return &pb.Command{CommandId: cmdID, RequestedBy: "0194f9d2-0000-7000-8000-0000000000aa",
		Op: &pb.Command_CreateSchedule{CreateSchedule: &pb.CreateSchedule{
			Name: name, Spec: &pb.ScheduleSpec{Template: template, Schedule: cron}, AdvancedSpecJson: []byte(advanced)}}}
}

func getSchedule(t *testing.T, c *dynamicfake.FakeDynamicClient, name string) *unstructured.Unstructured {
	t.Helper()
	obj, err := c.Resource(schedules).Namespace("velero").Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("schedule %s: %v", name, err)
	}
	return obj
}

func TestCreateScheduleEmbedsTheBackupTemplate(t *testing.T) {
	c := newBackupClient()
	res := scheduleHandler(c).Create(context.Background(), scheduleCmd("nightly", "0 2 * * *",
		&pb.BackupSpec{IncludedNamespaces: []string{"shop"}, Ttl: durationpb.New(72 * 3600e9)}, ""))
	if !res.Ok || res.GetCreated().GetKind() != "Schedule" {
		t.Fatalf("not created: %+v", res)
	}
	obj := getSchedule(t, c, "nightly")
	spec := obj.Object["spec"].(map[string]any)
	if spec["schedule"] != "0 2 * * *" {
		t.Errorf("schedule = %v", spec["schedule"])
	}
	tpl := spec["template"].(map[string]any)
	if tpl["ttl"] != "72h0m0s" || tpl["includedNamespaces"].([]any)[0] != "shop" {
		t.Errorf("template = %v", tpl)
	}
	if _, ok := spec["paused"]; ok {
		t.Error("an unpaused schedule must not carry paused, Velero's default applies")
	}
	if obj.GetAnnotations()[AnnotationManaged] != "true" || obj.GetLabels()[LabelCommandID] != cmdID {
		t.Errorf("not stamped: %v %v", obj.GetAnnotations(), obj.GetLabels())
	}
}

func TestCreateScheduleIsIdempotentPerCommand(t *testing.T) {
	c := newBackupClient()
	h := scheduleHandler(c)
	cmd := scheduleCmd("nightly", "@daily", &pb.BackupSpec{}, "")
	first := h.Create(context.Background(), cmd)
	second := h.Create(context.Background(), cmd)
	if !first.Ok || !second.Ok || count(t, c, schedules) != 1 {
		t.Fatalf("a re-delivered command made %d schedules: %+v %+v", count(t, c, schedules), first, second)
	}
}

func TestCreateScheduleRefusesWhatVeleroWouldNeverRun(t *testing.T) {
	for name, cmd := range map[string]*pb.Command{
		"bad cron":          scheduleCmd("a", "every day", &pb.BackupSpec{}, ""),
		"six fields":        scheduleCmd("a", "0 0 2 * * *", &pb.BackupSpec{}, ""),
		"no cron":           scheduleCmd("a", "", &pb.BackupSpec{}, ""),
		"bad name":          scheduleCmd("A_B", "@daily", &pb.BackupSpec{}, ""),
		"unknown advanced":  scheduleCmd("a", "@daily", &pb.BackupSpec{}, `{"nope":1}`),
		"advanced non-json": scheduleCmd("a", "@daily", &pb.BackupSpec{}, `[1]`),
	} {
		c := newBackupClient()
		res := scheduleHandler(c).Create(context.Background(), cmd)
		if res.Ok || res.ErrorCode != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
			t.Errorf("%s was accepted: %+v", name, res)
		}
		if count(t, c, schedules) != 0 {
			t.Errorf("%s left a schedule behind", name)
		}
	}
}

func TestAdvancedSettingsExtendTheTemplateNotTheSchedule(t *testing.T) {
	c := newBackupClient()
	res := scheduleHandler(c).Create(context.Background(), scheduleCmd("a", "@daily", &pb.BackupSpec{},
		`{"hooks":{"resources":[{"name":"x"}]}}`))
	if !res.Ok {
		t.Fatalf("%+v", res)
	}
	spec := getSchedule(t, c, "a").Object["spec"].(map[string]any)
	if _, ok := spec["template"].(map[string]any)["hooks"]; !ok {
		t.Errorf("hooks not on the template: %v", spec)
	}
	if _, ok := spec["hooks"]; ok {
		t.Error("hooks leaked onto the schedule spec")
	}
}

func TestUpdateReplacesTheSpecAndKeepsIdentity(t *testing.T) {
	c := newBackupClient()
	h := scheduleHandler(c)
	h.Create(context.Background(), scheduleCmd("a", "@daily", &pb.BackupSpec{IncludedNamespaces: []string{"shop"}}, ""))
	before := getSchedule(t, c, "a")

	res := h.Update(context.Background(), &pb.Command{CommandId: "other", Op: &pb.Command_UpdateSchedule{UpdateSchedule: &pb.UpdateSchedule{
		Name: "a", Spec: &pb.ScheduleSpec{Schedule: "0 3 * * 1", Template: &pb.BackupSpec{IncludedNamespaces: []string{"cart"}}}}}})
	if !res.Ok {
		t.Fatalf("%+v", res)
	}
	after := getSchedule(t, c, "a")
	spec := after.Object["spec"].(map[string]any)
	if spec["schedule"] != "0 3 * * 1" || spec["template"].(map[string]any)["includedNamespaces"].([]any)[0] != "cart" {
		t.Errorf("not replaced: %v", spec)
	}
	if after.GetUID() != before.GetUID() || after.GetLabels()[LabelCommandID] != cmdID {
		t.Error("an update must keep the object, not recreate it")
	}
	missing := h.Update(context.Background(), &pb.Command{Op: &pb.Command_UpdateSchedule{UpdateSchedule: &pb.UpdateSchedule{
		Name: "ghost", Spec: &pb.ScheduleSpec{Schedule: "@daily"}}}})
	if missing.Ok || missing.ErrorCode != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Errorf("updating a missing schedule: %+v", missing)
	}
}

func TestUpdateKeepsHooksTheFormCannotExpress(t *testing.T) {
	c := newBackupClient()
	h := scheduleHandler(c)
	h.Create(context.Background(), scheduleCmd("a", "@daily", &pb.BackupSpec{}, `{"hooks":{"resources":[{"name":"freeze"}]}}`))
	update := func(advanced string) {
		t.Helper()
		res := h.Update(context.Background(), &pb.Command{Op: &pb.Command_UpdateSchedule{UpdateSchedule: &pb.UpdateSchedule{
			Name: "a", Spec: &pb.ScheduleSpec{Schedule: "@hourly", Template: &pb.BackupSpec{}}, AdvancedSpecJson: []byte(advanced)}}})
		if !res.Ok {
			t.Fatalf("%+v", res)
		}
	}
	hookName := func() any {
		tpl := getSchedule(t, c, "a").Object["spec"].(map[string]any)["template"].(map[string]any)
		hooks, ok := tpl["hooks"].(map[string]any)
		if !ok {
			return nil
		}
		return hooks["resources"].([]any)[0].(map[string]any)["name"]
	}
	update("")
	if hookName() != "freeze" {
		t.Error("an update through the form dropped the hooks")
	}
	update(`{"hooks":{"resources":[{"name":"thaw"}]}}`)
	if hookName() != "thaw" {
		t.Error("hooks sent explicitly must win")
	}
}

func TestPauseAndResumeTouchOnlyPaused(t *testing.T) {
	c := newBackupClient()
	h := scheduleHandler(c)
	h.Create(context.Background(), scheduleCmd("a", "@daily", &pb.BackupSpec{IncludedNamespaces: []string{"shop"}}, ""))
	pause := func(p bool) *pb.CommandResult {
		return h.SetPaused(context.Background(), &pb.Command{Op: &pb.Command_SetSchedulePaused{
			SetSchedulePaused: &pb.SetSchedulePaused{Name: "a", Paused: p}}})
	}
	if r := pause(true); !r.Ok {
		t.Fatalf("%+v", r)
	}
	spec := getSchedule(t, c, "a").Object["spec"].(map[string]any)
	if spec["paused"] != true || spec["schedule"] != "@daily" || spec["template"] == nil {
		t.Errorf("pause changed more than paused: %v", spec)
	}
	pause(false)
	if getSchedule(t, c, "a").Object["spec"].(map[string]any)["paused"] != false {
		t.Error("not resumed")
	}
	if r := h.SetPaused(context.Background(), &pb.Command{Op: &pb.Command_SetSchedulePaused{
		SetSchedulePaused: &pb.SetSchedulePaused{Name: "ghost", Paused: true}}}); r.ErrorCode != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Errorf("pausing a missing schedule: %+v", r)
	}
}

func TestDeleteScheduleLeavesItsBackups(t *testing.T) {
	c := newBackupClient()
	h := scheduleHandler(c)
	h.Create(context.Background(), scheduleCmd("a", "@daily", &pb.BackupSpec{}, ""))
	h.createBackup(context.Background(), &pb.Command{CommandId: "b"}, "a-1", map[string]any{}, map[string]string{LabelScheduleName: "a"})

	del := func(name string) *pb.CommandResult {
		return h.Delete(context.Background(), &pb.Command{Op: &pb.Command_DeleteSchedule{DeleteSchedule: &pb.DeleteSchedule{Name: name}}})
	}
	res := del("a")
	if !res.Ok || res.GetCreated().GetKind() != "DeletedSchedule" || count(t, c, schedules) != 0 {
		t.Fatalf("not deleted: %+v", res)
	}
	if count(t, c, backups) != 1 {
		t.Error("deleting a schedule must not delete its backups")
	}
	if r := del("a"); r.ErrorCode != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Errorf("deleting twice: %+v", r)
	}
}

func TestValidateCron(t *testing.T) {
	good := []string{"* * * * *", "0 2 * * *", "*/15 0-6 1,15 jan-mar mon-fri", "0 0 ? * sun", "@hourly", "@every 90m", "5 4 * * 0", "0 0 31 12 6"}
	bad := map[string]string{
		"":                 "required",
		"* * * *":          "five fields",
		"* * * * * *":      "five fields",
		"60 * * * *":       "minute",
		"* 24 * * *":       "hour",
		"* * 0 * *":        "day of month",
		"* * * 13 *":       "month",
		"* * * * 7":        "day of week",
		"*/0 * * * *":      "step",
		"5-1 * * * *":      "backwards",
		"a * * * *":        "minute",
		"1,,2 * * * *":     "empty",
		"@sometimes":       "descriptor",
		"@every 0s":        "@every",
		"@every banana":    "@every",
		"? * * * *":        "minute",
		"* * * * mon-sunx": "day of week",
	}
	for _, expr := range good {
		if err := ValidateCron(expr); err != nil {
			t.Errorf("%q refused: %v", expr, err)
		}
	}
	for expr, want := range bad {
		err := ValidateCron(expr)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want it to mention %q", expr, err, want)
		}
	}
}
