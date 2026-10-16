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

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

func newRestoreClient(objs ...runtime.Object) *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			backups: "BackupList", schedules: "ScheduleList", restores: "RestoreList",
		}, objs...)
}

func restoreHandler(c *dynamicfake.FakeDynamicClient, p policy.Policy) *RestoreHandler {
	return &RestoreHandler{
		BackupHandler: *backupHandler(c),
		Policy:        func() policy.Policy { return p },
	}
}

func restoreCmd(name string, spec *pb.RestoreSpec, advanced string) *pb.Command {
	return &pb.Command{CommandId: cmdID, RequestedBy: "0194f9d2-0000-7000-8000-0000000000aa",
		Op: &pb.Command_CreateRestore{CreateRestore: &pb.CreateRestore{Name: name, Spec: spec, AdvancedSpecJson: []byte(advanced)}}}
}

func getRestore(t *testing.T, c *dynamicfake.FakeDynamicClient, name string) *unstructured.Unstructured {
	t.Helper()
	obj, err := c.Resource(restores).Namespace("velero").Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("restore %s: %v", name, err)
	}
	return obj
}

func TestRestoreSpecCarriesEveryFlagInVelerosShape(t *testing.T) {
	spec := &pb.RestoreSpec{
		BackupName:              "nightly-1",
		IncludedNamespaces:      []string{"shop"},
		ExcludedNamespaces:      []string{"tmp"},
		IncludedResources:       []string{"pods"},
		ExcludedResources:       []string{"events"},
		NamespaceMapping:        map[string]string{"shop": "shop-restored"},
		LabelSelector:           &pb.LabelSelector{MatchLabels: map[string]string{"app": "web"}},
		OrLabelSelectors:        []*pb.LabelSelector{{MatchLabels: map[string]string{"a": "b"}}},
		RestorePvs:              ptr(false),
		RestoreStatus:           &pb.RestoreStatusSpec{IncludedResources: []string{"workflows"}},
		PreserveNodePorts:       ptr(true),
		IncludeClusterResources: ptr(false),
		ExistingResourcePolicy:  pb.ExistingResourcePolicy_EXISTING_RESOURCE_POLICY_UPDATE,
		ItemOperationTimeout:    durationpb.New(2 * time.Hour),
		ResourceModifier:        &pb.TypedLocalObjectReference{Kind: "ConfigMap", Name: "mods"},
		UploaderConfig:          &pb.UploaderConfigForRestore{WriteSparseFiles: ptr(true), ParallelFilesDownload: 3},
	}
	got := RestoreSpecMap(spec)
	if err := validateSpec(restoreKind, got); err != nil {
		t.Fatalf("what the agent generates must satisfy its own schema: %v", err)
	}
	for key, want := range map[string]any{
		"backupName": "nightly-1", "restorePVs": false, "preserveNodePorts": true, "includeClusterResources": false,
		"existingResourcePolicy": "update", "itemOperationTimeout": "2h0m0s",
	} {
		if got[key] != want {
			t.Errorf("%s = %v, want %v", key, got[key], want)
		}
	}
	if got["namespaceMapping"].(map[string]any)["shop"] != "shop-restored" {
		t.Errorf("%v", got["namespaceMapping"])
	}
	u := got["uploaderConfig"].(map[string]any)
	if u["writeSparseFiles"] != true || u["parallelFilesDownload"] != int64(3) {
		t.Errorf("%v", u)
	}
	if got["restoreStatus"].(map[string]any)["includedResources"].([]any)[0] != "workflows" {
		t.Errorf("%v", got["restoreStatus"])
	}
}

func TestCreatesTheRestoreWithOurLabelsAndAGeneratedName(t *testing.T) {
	c := newRestoreClient(backupObject("nightly-1", "u"))
	res := restoreHandler(c, policy.Default()).Create(context.Background(), restoreCmd("", &pb.RestoreSpec{
		BackupName: "nightly-1", IncludedNamespaces: []string{"shop"}}, ""))

	if !res.GetOk() || res.GetCreated().GetKind() != "Restore" || res.GetCreated().GetName() != "nightly-1-20261016010203" {
		t.Fatalf("%v", res)
	}
	obj := getRestore(t, c, "nightly-1-20261016010203")
	if obj.GetLabels()[LabelCommandID] != cmdID || obj.GetAnnotations()[AnnotationManaged] != "true" {
		t.Fatalf("%v", obj.Object)
	}
}

func TestARestoreNeedsExactlyOneSource(t *testing.T) {
	c := newRestoreClient(backupObject("b", "u"), scheduleObject("s", map[string]any{}))
	h := restoreHandler(c, policy.Default())
	for name, spec := range map[string]*pb.RestoreSpec{
		"none": {IncludedNamespaces: []string{"shop"}},
		"both": {BackupName: "b", ScheduleName: "s", IncludedNamespaces: []string{"shop"}},
	} {
		if res := h.Create(context.Background(), restoreCmd("", spec, "")); res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
			t.Errorf("%s: %v", name, res)
		}
	}
	if res := h.Create(context.Background(), restoreCmd("", &pb.RestoreSpec{ScheduleName: "s", IncludedNamespaces: []string{"shop"}}, "")); !res.GetOk() {
		t.Errorf("from a schedule: %v", res)
	}
	// The advanced settings can supply the source, and must not add a second one.
	if res := h.Create(context.Background(), restoreCmd("", &pb.RestoreSpec{BackupName: "b"}, `{"scheduleName":"s"}`)); res.GetOk() {
		t.Errorf("two sources through the advanced spec were accepted: %v", res)
	}
}

func TestARestoreFromAMissingSourceIsNotFoundAndMakesNothing(t *testing.T) {
	c := newRestoreClient()
	h := restoreHandler(c, policy.Default())
	if res := h.Create(context.Background(), restoreCmd("", &pb.RestoreSpec{BackupName: "gone", IncludedNamespaces: []string{"shop"}}, "")); res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("%v", res)
	}
	if res := h.Create(context.Background(), restoreCmd("", &pb.RestoreSpec{ScheduleName: "gone", IncludedNamespaces: []string{"shop"}}, "")); res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("%v", res)
	}
	if count(t, c, restores) != 0 {
		t.Fatal("created a restore from nothing")
	}
}

func TestAnAdvancedSpecCannotStepAroundTheOwnersPolicy(t *testing.T) {
	// The dispatcher judged the typed command; the advanced settings are merged on afterwards,
	// so the handler must judge the spec that will really be created.
	protected := policy.Default() // kube-system, vfm-system and velero are protected
	for name, advanced := range map[string]string{
		"a protected namespace": `{"includedNamespaces":["kube-system"]}`,
		"a mapping into one":    `{"namespaceMapping":{"shop":"velero"}}`,
		"all namespaces":        `{"includedNamespaces":[]}`,
		"the wildcard":          `{"includedNamespaces":["*"]}`,
	} {
		c := newRestoreClient(backupObject("b", "u"))
		res := restoreHandler(c, protected).Create(context.Background(), restoreCmd("", &pb.RestoreSpec{BackupName: "b", IncludedNamespaces: []string{"shop"}}, advanced))
		if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY {
			t.Errorf("%s: %v", name, res)
		}
		if count(t, c, restores) != 0 {
			t.Errorf("%s: a restore was created", name)
		}
	}
	// Excluding the protected namespaces makes "all" allowed.
	c := newRestoreClient(backupObject("b", "u"))
	res := restoreHandler(c, protected).Create(context.Background(), restoreCmd("", &pb.RestoreSpec{BackupName: "b", ExcludedNamespaces: []string{"kube-system", "vfm-system", "velero"}}, ""))
	if !res.GetOk() {
		t.Errorf("%v", res)
	}
}

func TestTheOwnersPolicyApplies(t *testing.T) {
	locked := policy.Default()
	locked.RestoreDeniedNamespaces = []string{"*"}
	c := newRestoreClient(backupObject("b", "u"))
	if res := restoreHandler(c, locked).Create(context.Background(), restoreCmd("", &pb.RestoreSpec{BackupName: "b", IncludedNamespaces: []string{"shop"}}, "")); res.GetOk() {
		t.Fatalf("%v", res)
	}
	h := restoreHandler(c, policy.Default())
	h.Policy = nil
	if res := h.Create(context.Background(), restoreCmd("", &pb.RestoreSpec{BackupName: "b", IncludedNamespaces: []string{"shop"}}, "")); res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INTERNAL {
		t.Fatalf("a handler without a policy must not restore: %v", res)
	}
}

func TestRestoreAdvancedSpecIsStrict(t *testing.T) {
	base := RestoreSpecMap(&pb.RestoreSpec{BackupName: "b"})
	if _, err := ApplyAdvancedRestore(base, []byte(`{"hooks":{"resources":[{"name":"h","postHooks":[{"exec":{"command":["x"],"waitForReady":true}},{"init":{"initContainers":[{"name":"i","image":"x"}],"timeout":"1m"}}]}]}}`)); err != nil {
		t.Fatalf("a real restore hook was refused: %v", err)
	}
	for name, raw := range map[string]string{
		"a backup-only field": `{"snapshotVolumes":true}`,
		"a typo":              `{"existingResourcePolicy2":"none"}`,
		"wrong type":          `{"restorePVs":"no"}`,
		"unknown in a hook":   `{"hooks":{"resources":[{"name":"h","postHooks":[{"exec":{"nope":"x"}}]}]}}`,
		"bad mapping value":   `{"namespaceMapping":{"a":1}}`,
	} {
		if _, err := ApplyAdvancedRestore(base, []byte(raw)); err == nil {
			t.Errorf("%s was accepted", name)
		} else if name == "a backup-only field" && !strings.Contains(err.Error(), "Restore spec") {
			t.Errorf("the message should name the kind: %v", err)
		}
	}
	if _, err := ApplyAdvancedRestore(base, []byte(`{"existingResourcePolicy":"merge"}`)); err != nil {
		t.Logf("the enum is checked by the handler: %v", err)
	}
}

func TestAnUnknownExistingResourcePolicyIsRefused(t *testing.T) {
	c := newRestoreClient(backupObject("b", "u"))
	res := restoreHandler(c, policy.Default()).Create(context.Background(), restoreCmd("", &pb.RestoreSpec{BackupName: "b", IncludedNamespaces: []string{"shop"}}, `{"existingResourcePolicy":"merge"}`))
	if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
		t.Fatalf("%v", res)
	}
}

func TestARedeliveredRestoreCommandFindsItsRestore(t *testing.T) {
	c := newRestoreClient(backupObject("b", "u"))
	h := restoreHandler(c, policy.Default())
	spec := &pb.RestoreSpec{BackupName: "b", IncludedNamespaces: []string{"shop"}}
	first := h.Create(context.Background(), restoreCmd("", spec, ""))
	h.Now = func() time.Time { return time.Date(2026, 10, 16, 3, 0, 0, 0, time.UTC) }
	again := h.Create(context.Background(), restoreCmd("", spec, ""))
	if !again.GetOk() || again.GetCreated().GetName() != first.GetCreated().GetName() || count(t, c, restores) != 1 {
		t.Fatalf("%v / %v / %d", first, again, count(t, c, restores))
	}
}

func TestGeneratedRestoreNamesStayWithinTheLabelLimit(t *testing.T) {
	long := strings.Repeat("b", 63)
	c := newRestoreClient(backupObject(long, "u"))
	res := restoreHandler(c, policy.Default()).Create(context.Background(), restoreCmd("", &pb.RestoreSpec{BackupName: long, IncludedNamespaces: []string{"shop"}}, ""))
	if !res.GetOk() || len(res.GetCreated().GetName()) > 63 {
		t.Fatalf("%v", res)
	}
}

func TestDeletingARestoreRemovesTheRestoreObjectOnly(t *testing.T) {
	r := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1", "kind": "Restore",
		"metadata": map[string]any{"name": "r1", "namespace": "velero", "uid": "u-r"}, "spec": map[string]any{"backupName": "b"},
	}}
	c := newRestoreClient(backupObject("b", "u"), r)
	res := restoreHandler(c, policy.Default()).Delete(context.Background(), &pb.Command{CommandId: cmdID,
		Op: &pb.Command_DeleteRestore{DeleteRestore: &pb.DeleteRestore{Name: "r1"}}})

	if !res.GetOk() || res.GetCreated().GetKind() != "DeletedRestore" || res.GetCreated().GetName() != "r1" {
		t.Fatalf("%v", res)
	}
	if count(t, c, restores) != 0 || count(t, c, backups) != 1 {
		t.Fatalf("restores %d backups %d", count(t, c, restores), count(t, c, backups))
	}
	if res := restoreHandler(c, policy.Default()).Delete(context.Background(), &pb.Command{CommandId: cmdID,
		Op: &pb.Command_DeleteRestore{DeleteRestore: &pb.DeleteRestore{Name: "r1"}}}); res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("a restore that is gone is NOT_FOUND, not a success: %v", res)
	}
	if res := restoreHandler(c, policy.Default()).Delete(context.Background(), &pb.Command{CommandId: cmdID,
		Op: &pb.Command_DeleteRestore{DeleteRestore: &pb.DeleteRestore{Name: "Bad Name"}}}); res.GetOk() {
		t.Fatalf("%v", res)
	}
}
