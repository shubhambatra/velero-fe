package velero

import (
	"context"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

func ptr[T any](v T) *T { return &v }

func newBackupClient(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			backups: "BackupList", schedules: "ScheduleList", deleteBackupRequests: "DeleteBackupRequestList",
		}, objs...)
}

func backupHandler(c *dynamicfake.FakeDynamicClient) *BackupHandler {
	return &BackupHandler{Dynamic: c, Namespace: "velero",
		Now: func() time.Time { return time.Date(2026, 10, 16, 1, 2, 3, 0, time.UTC) }}
}

func createCmd(name string, spec *pb.BackupSpec, advanced string) *pb.Command {
	return &pb.Command{CommandId: cmdID, RequestedBy: "0194f9d2-0000-7000-8000-0000000000aa",
		Op: &pb.Command_CreateBackup{CreateBackup: &pb.CreateBackup{Name: name, Spec: spec, AdvancedSpecJson: []byte(advanced)}}}
}

func getBackup(t *testing.T, c *dynamicfake.FakeDynamicClient, name string) *unstructured.Unstructured {
	t.Helper()
	obj, err := c.Resource(backups).Namespace("velero").Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("backup %s: %v", name, err)
	}
	return obj
}

func count(t *testing.T, c *dynamicfake.FakeDynamicClient, gvr schema.GroupVersionResource) int {
	t.Helper()
	list, err := c.Resource(gvr).Namespace("velero").List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return len(list.Items)
}

func TestBackupSpecCarriesEveryFlagInVelerosShape(t *testing.T) {
	spec := &pb.BackupSpec{
		MetadataLabels:                   map[string]string{"team": "shop"},
		IncludedNamespaces:               []string{"shop", "cart"},
		ExcludedNamespaces:               []string{"tmp"},
		IncludedResources:                []string{"pods"},
		ExcludedResources:                []string{"events"},
		IncludedClusterScopedResources:   []string{"persistentvolumes"},
		ExcludedClusterScopedResources:   []string{"nodes"},
		IncludedNamespaceScopedResources: []string{"deployments"},
		ExcludedNamespaceScopedResources: []string{"secrets"},
		LabelSelector:                    &pb.LabelSelector{MatchLabels: map[string]string{"app": "web"}},
		OrLabelSelectors: []*pb.LabelSelector{{MatchExpressions: []*pb.LabelSelectorRequirement{
			{Key: "tier", Operator: "In", Values: []string{"a", "b"}}}}},
		SnapshotVolumes:             ptr(false),
		Ttl:                         durationpb.New(72 * time.Hour),
		VolumeGroupSnapshotLabelKey: "vgs",
		IncludeClusterResources:     ptr(false),
		StorageLocation:             "default",
		VolumeSnapshotLocations:     []string{"aws"},
		DefaultVolumesToFsBackup:    ptr(true),
		OrderedResources:            map[string]string{"pods": "shop/a,shop/b"},
		CsiSnapshotTimeout:          durationpb.New(10 * time.Minute),
		ItemOperationTimeout:        durationpb.New(4 * time.Hour),
		ResourcePolicy:              &pb.TypedLocalObjectReference{ApiGroup: "", Kind: "ConfigMap", Name: "policy"},
		SnapshotMoveData:            ptr(true),
		DataMover:                   "velero",
		UploaderConfig:              &pb.UploaderConfigForBackup{ParallelFilesUpload: 4},
		Hooks: &pb.BackupHooks{Resources: []*pb.BackupResourceHookSpec{{
			Name: "freeze", IncludedNamespaces: []string{"shop"},
			Pre: []*pb.ExecHook{{Container: "db", Command: []string{"/bin/sync"}, OnError: pb.HookErrorMode_HOOK_ERROR_MODE_FAIL, Timeout: durationpb.New(30 * time.Second)}},
		}}},
	}
	got := BackupSpecMap(spec)
	if err := ValidateBackupSpec(got); err != nil {
		t.Fatalf("what the agent generates must satisfy its own schema: %v", err)
	}
	for key, want := range map[string]any{
		"ttl": "72h0m0s", "csiSnapshotTimeout": "10m0s", "itemOperationTimeout": "4h0m0s",
		"snapshotVolumes": false, "includeClusterResources": false, "defaultVolumesToFsBackup": true,
		"snapshotMoveData": true, "datamover": "velero", "storageLocation": "default",
	} {
		if got[key] != want {
			t.Errorf("%s = %v, want %v", key, got[key], want)
		}
	}
	if u := got["uploaderConfig"].(map[string]any); u["parallelFilesUpload"] != int64(4) {
		t.Errorf("uploaderConfig %v", u)
	}
	hook := got["hooks"].(map[string]any)["resources"].([]any)[0].(map[string]any)["pre"].([]any)[0].(map[string]any)["exec"].(map[string]any)
	if hook["onError"] != "Fail" || hook["timeout"] != "30s" || hook["container"] != "db" {
		t.Errorf("hook %v", hook)
	}
	if got["metadata"].(map[string]any)["labels"].(map[string]any)["team"] != "shop" {
		t.Errorf("metadata %v", got["metadata"])
	}
}

func TestUnsetFlagsAreLeftToVelerosDefaults(t *testing.T) {
	if got := BackupSpecMap(&pb.BackupSpec{IncludedNamespaces: []string{"shop"}}); len(got) != 1 {
		t.Fatalf("only what was set may be emitted: %v", got)
	}
	// An explicit false is a choice, not an absence.
	got := BackupSpecMap(&pb.BackupSpec{SnapshotVolumes: ptr(false)})
	if v, ok := got["snapshotVolumes"]; !ok || v != false {
		t.Fatalf("%v", got)
	}
}

func TestAdvancedSpecIsMergedThenValidatedStrictly(t *testing.T) {
	base := BackupSpecMap(&pb.BackupSpec{IncludedNamespaces: []string{"shop"}, StorageLocation: "default"})

	merged, err := ApplyAdvanced(base, []byte(`{"storageLocation":"other","hooks":{"resources":[{"name":"h","pre":[{"exec":{"command":["x"]}}]}]},"metadata":{"labels":{"a":"b"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if merged["storageLocation"] != "other" || merged["includedNamespaces"] == nil {
		t.Fatalf("a later value replaces, the rest stays: %v", merged)
	}
	if base["storageLocation"] != "default" {
		t.Fatal("the generated spec must not be mutated")
	}

	for name, raw := range map[string]string{
		"unknown top-level":  `{"includedNamespace":["x"]}`,
		"typo with a string": `{"storageLocatoin":"x"}`,
		"unknown nested str": `{"hooks":{"resources":[{"name":"h","nope":"x"}]}}`,
		"unknown nested":     `{"hooks":{"resources":[{"name":"h","nope":1}]}}`,
		"wrong type":         `{"snapshotVolumes":"yes"}`,
		"list for string":    `{"storageLocation":["a"]}`,
		"bad duration":       `{"ttl":"a month"}`,
		"negative duration":  `{"ttl":"-5h"}`,
		"number in list":     `{"includedNamespaces":[1]}`,
		"non-integer":        `{"uploaderConfig":{"parallelFilesUpload":1.5}}`,
		"null for object":    `{"labelSelector":null}`,
		"not an object":      `["a"]`,
		"trailing document":  `{} {}`,
		"not json":           `{`,
		"string in map":      `{"orderedResources":{"pods":1}}`,
		"exec not an object": `{"hooks":{"resources":[{"name":"h","pre":[{"exec":"ls"}]}]}}`,
	} {
		if _, err := ApplyAdvanced(base, []byte(raw)); err == nil {
			t.Errorf("%s: %s was accepted", name, raw)
		}
	}
	if _, err := ApplyAdvanced(base, []byte(`{"a":1,"b":2}`)); err == nil || !strings.Contains(err.Error(), "spec.a") || !strings.Contains(err.Error(), "spec.b") {
		t.Errorf("every problem should be reported with its path: %v", err)
	}
	if _, err := ApplyAdvanced(base, make([]byte, MaxAdvancedSpecBytes+1)); err == nil {
		t.Error("an oversized document was accepted")
	}
	if _, err := ApplyAdvanced(base, nil); err != nil {
		t.Errorf("no advanced spec is fine: %v", err)
	}
}

func TestCreatesTheBackupWithOurLabelsAndTheSpec(t *testing.T) {
	c := newBackupClient()
	res := backupHandler(c).Create(context.Background(), createCmd("nightly-1", &pb.BackupSpec{IncludedNamespaces: []string{"shop"}, Ttl: durationpb.New(24 * time.Hour)}, ""))

	if !res.GetOk() || res.GetCreated().GetKind() != "Backup" || res.GetCreated().GetName() != "nightly-1" {
		t.Fatalf("%v", res)
	}
	obj := getBackup(t, c, "nightly-1")
	if obj.GetLabels()[LabelCommandID] != cmdID || obj.GetLabels()[LabelRequestedBy] == "" || obj.GetAnnotations()[AnnotationManaged] != "true" {
		t.Fatalf("labels %v annotations %v", obj.GetLabels(), obj.GetAnnotations())
	}
	ns, _, _ := unstructured.NestedStringSlice(obj.Object, "spec", "includedNamespaces")
	ttl, _, _ := unstructured.NestedString(obj.Object, "spec", "ttl")
	if len(ns) != 1 || ns[0] != "shop" || ttl != "24h0m0s" || obj.GetNamespace() != "velero" {
		t.Fatalf("%v", obj.Object)
	}
}

func TestGeneratesANameLikeTheCLIWhenNoneIsGiven(t *testing.T) {
	c := newBackupClient()
	res := backupHandler(c).Create(context.Background(), createCmd("", &pb.BackupSpec{}, ""))
	if res.GetCreated().GetName() != "backup-20261016010203" {
		t.Fatalf("%v", res)
	}
}

func TestRefusesNamesKubernetesWouldRefuseOrVeleroCannotLabel(t *testing.T) {
	c := newBackupClient()
	for _, name := range []string{"Upper", "-lead", "trail-", "under_score", "with space", strings.Repeat("a", 64), "../x"} {
		if res := backupHandler(c).Create(context.Background(), createCmd(name, &pb.BackupSpec{}, "")); res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
			t.Errorf("%q: %v", name, res)
		}
	}
	if len(c.Actions()) != 0 {
		t.Fatalf("a refused request must not touch the cluster: %v", c.Actions())
	}
}

func TestAnInvalidAdvancedSpecCreatesNothing(t *testing.T) {
	c := newBackupClient()
	res := backupHandler(c).Create(context.Background(), createCmd("x", &pb.BackupSpec{}, `{"snapshotVolume":true}`))
	if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT || !strings.Contains(res.GetErrorMessage(), "spec.snapshotVolume") {
		t.Fatalf("%v", res)
	}
	if count(t, c, backups) != 0 {
		t.Fatal("created a backup from an invalid spec")
	}
}

func TestARedeliveredCommandFindsItsBackupInsteadOfMakingAnother(t *testing.T) {
	c := newBackupClient()
	h := backupHandler(c)
	first := h.Create(context.Background(), createCmd("nightly-1", &pb.BackupSpec{}, ""))
	// The same command arrives again (an agent restart lost its memory), even with another name.
	again := h.Create(context.Background(), createCmd("something-else", &pb.BackupSpec{}, ""))

	if !again.GetOk() || again.GetCreated().GetName() != first.GetCreated().GetName() || count(t, c, backups) != 1 {
		t.Fatalf("%v / %v / %d", first, again, count(t, c, backups))
	}
}

func TestANameAlreadyTakenIsReportedAsSuch(t *testing.T) {
	c := newBackupClient()
	h := backupHandler(c)
	h.Create(context.Background(), createCmd("taken", &pb.BackupSpec{}, ""))
	other := createCmd("taken", &pb.BackupSpec{}, "")
	other.CommandId = "0194f9d2-0000-7000-8000-00000000c002"
	if res := h.Create(context.Background(), other); res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_ALREADY_EXISTS {
		t.Fatalf("%v", res)
	}
}

func TestKubernetesFailuresAreTypedAndNeverEchoTheAPIBody(t *testing.T) {
	c := newBackupClient()
	c.PrependReactor("create", "backups", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, &forbidden{}
	})
	res := backupHandler(c).Create(context.Background(), createCmd("x", &pb.BackupSpec{}, ""))
	if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR || strings.Contains(res.GetErrorMessage(), "secret-detail") {
		t.Fatalf("%v", res)
	}
}

func scheduleObject(name string, template map[string]any) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1", "kind": "Schedule",
		"metadata": map[string]any{"name": name, "namespace": "velero"},
		"spec":     map[string]any{"schedule": "0 2 * * *", "template": template},
	}}
}

func triggerCmd(schedule, name string) *pb.Command {
	return &pb.Command{CommandId: cmdID, RequestedBy: "0194f9d2-0000-7000-8000-0000000000aa",
		Op: &pb.Command_TriggerSchedule{TriggerSchedule: &pb.TriggerScheduleNow{ScheduleName: schedule, BackupName: name}}}
}

func TestTriggeringAScheduleMakesABackupFromItsTemplate(t *testing.T) {
	c := newBackupClient(scheduleObject("nightly", map[string]any{
		"includedNamespaces": []any{"shop"}, "ttl": "48h0m0s", "someFutureField": true,
	}))
	res := backupHandler(c).TriggerSchedule(context.Background(), triggerCmd("nightly", ""))

	if !res.GetOk() || res.GetCreated().GetName() != "nightly-20261016010203" {
		t.Fatalf("%v", res)
	}
	obj := getBackup(t, c, "nightly-20261016010203")
	ttl, _, _ := unstructured.NestedString(obj.Object, "spec", "ttl")
	future, _, _ := unstructured.NestedBool(obj.Object, "spec", "someFutureField")
	if obj.GetLabels()[LabelScheduleName] != "nightly" || obj.GetLabels()[LabelCommandID] != cmdID || ttl != "48h0m0s" || !future {
		t.Fatalf("a template Velero accepted is copied as it is, whatever this agent knows: %v", obj.Object)
	}
}

func TestTriggeringHonoursAGivenNameAndRefusesBadOnes(t *testing.T) {
	c := newBackupClient(scheduleObject("nightly", map[string]any{}))
	if res := backupHandler(c).TriggerSchedule(context.Background(), triggerCmd("nightly", "manual-1")); res.GetCreated().GetName() != "manual-1" {
		t.Fatalf("%v", res)
	}
	if res := backupHandler(c).TriggerSchedule(context.Background(), triggerCmd("nightly", "Bad Name")); res.GetOk() {
		t.Fatalf("%v", res)
	}
	long := strings.Repeat("s", 55)
	c2 := newBackupClient(scheduleObject(long, map[string]any{}))
	if res := backupHandler(c2).TriggerSchedule(context.Background(), triggerCmd(long, "")); res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatalf("a generated name past 63 characters must be refused, not truncated: %v", res)
	}
}

func TestTriggeringAMissingScheduleOrOneWithoutATemplateFails(t *testing.T) {
	c := newBackupClient()
	if res := backupHandler(c).TriggerSchedule(context.Background(), triggerCmd("nope", "")); res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("%v", res)
	}
	bare := scheduleObject("bare", nil)
	delete(bare.Object["spec"].(map[string]any), "template")
	c2 := newBackupClient(bare)
	if res := backupHandler(c2).TriggerSchedule(context.Background(), triggerCmd("bare", "")); res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatalf("%v", res)
	}
}

func TestTriggeringTwiceForOneCommandMakesOneBackup(t *testing.T) {
	c := newBackupClient(scheduleObject("nightly", map[string]any{}))
	h := backupHandler(c)
	h.TriggerSchedule(context.Background(), triggerCmd("nightly", ""))
	h.Now = func() time.Time { return time.Date(2026, 10, 16, 1, 9, 9, 0, time.UTC) }
	h.TriggerSchedule(context.Background(), triggerCmd("nightly", ""))
	if count(t, c, backups) != 1 {
		t.Fatalf("%d backups", count(t, c, backups))
	}
}

func backupObject(name, uid string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1", "kind": "Backup",
		"metadata": map[string]any{"name": name, "namespace": "velero", "uid": uid},
		"spec":     map[string]any{},
	}}
}

func deleteCmd(name string) *pb.Command {
	return &pb.Command{CommandId: cmdID, RequestedBy: "0194f9d2-0000-7000-8000-0000000000aa",
		Op: &pb.Command_DeleteBackup{DeleteBackup: &pb.DeleteBackup{Name: name}}}
}

func TestDeletingABackupAsksVeleroToDeleteItAndLeavesTheObjectToVelero(t *testing.T) {
	c := newBackupClient(backupObject("old", "uid-123"))
	res := backupHandler(c).Delete(context.Background(), deleteCmd("old"))

	if !res.GetOk() || res.GetCreated().GetKind() != "DeleteBackupRequest" {
		t.Fatalf("%v", res)
	}
	list, _ := c.Resource(deleteBackupRequests).Namespace("velero").List(context.Background(), metav1.ListOptions{})
	if len(list.Items) != 1 {
		t.Fatalf("%d requests", len(list.Items))
	}
	req := list.Items[0]
	name, _, _ := unstructured.NestedString(req.Object, "spec", "backupName")
	if name != "old" || req.GetLabels()[LabelBackupName] != "old" || req.GetLabels()[LabelBackupUID] != "uid-123" || req.GetLabels()[LabelCommandID] != cmdID {
		t.Fatalf("%v", req.Object)
	}
	if !strings.HasPrefix(req.GetName(), "old-") || len(req.GetName()) > 63 {
		t.Fatalf("name %q", req.GetName())
	}
	for _, a := range c.Actions() {
		if a.GetVerb() == "delete" {
			t.Fatal("the Backup object itself must never be deleted: its data would stay in storage")
		}
	}
}

func TestDeletingKeepsLongBackupNamesWithinTheLabelLimit(t *testing.T) {
	long := strings.Repeat("b", 63)
	c := newBackupClient(backupObject(long, "u"))
	res := backupHandler(c).Delete(context.Background(), deleteCmd(long))
	list, _ := c.Resource(deleteBackupRequests).Namespace("velero").List(context.Background(), metav1.ListOptions{})
	if !res.GetOk() || len(list.Items) != 1 || len(list.Items[0].GetName()) > 63 {
		t.Fatalf("%v", res)
	}
}

func TestDeletingAMissingBackupIsNotFoundAndARetryIsIdempotent(t *testing.T) {
	c := newBackupClient()
	if res := backupHandler(c).Delete(context.Background(), deleteCmd("gone")); res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("%v", res)
	}
	c2 := newBackupClient(backupObject("old", "u"))
	h := backupHandler(c2)
	h.Delete(context.Background(), deleteCmd("old"))
	if res := h.Delete(context.Background(), deleteCmd("old")); !res.GetOk() || count(t, c2, deleteBackupRequests) != 1 {
		t.Fatalf("%v / %d", res, count(t, c2, deleteBackupRequests))
	}
}

// forbidden is an API error whose message must never reach the control plane.
type forbidden struct{}

func (*forbidden) Error() string { return "secret-detail: forbidden" }
