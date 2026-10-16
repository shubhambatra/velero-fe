package policy

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

func restore(spec *pb.RestoreSpec) *pb.Command {
	return &pb.Command{Op: &pb.Command_CreateRestore{CreateRestore: &pb.CreateRestore{Spec: spec}}}
}

func TestDefaultAllowsOrdinaryWorkAndProtectsSystemNamespaces(t *testing.T) {
	p := Default()
	cases := []struct {
		name string
		cmd  *pb.Command
		deny bool
	}{
		{"refresh", &pb.Command{Op: &pb.Command_RefreshStatus{}}, false},
		{"backup", &pb.Command{Op: &pb.Command_CreateBackup{CreateBackup: &pb.CreateBackup{}}}, false},
		{"restore of an app namespace", restore(&pb.RestoreSpec{IncludedNamespaces: []string{"shop"}}), false},
		{"restore naming kube-system", restore(&pb.RestoreSpec{IncludedNamespaces: []string{"shop", "kube-system"}}), true},
		{"restore naming velero", restore(&pb.RestoreSpec{IncludedNamespaces: []string{"velero"}}), true},
		{"restore of everything", restore(&pb.RestoreSpec{}), true},
		{"restore of everything with a star", restore(&pb.RestoreSpec{IncludedNamespaces: []string{"*"}}), true},
		{"restore of everything, protected namespaces excluded", restore(&pb.RestoreSpec{
			ExcludedNamespaces: []string{"kube-system", "vfm-system", "velero"}}), false},
		{"restore of everything, only some excluded", restore(&pb.RestoreSpec{
			ExcludedNamespaces: []string{"kube-system"}}), true},
		{"restore mapped into a protected namespace", restore(&pb.RestoreSpec{
			IncludedNamespaces: []string{"shop"}, NamespaceMapping: map[string]string{"shop": "kube-system"}}), true},
		{"restore mapped into an ordinary namespace", restore(&pb.RestoreSpec{
			IncludedNamespaces: []string{"shop"}, NamespaceMapping: map[string]string{"shop": "shop-copy"}}), false},
	}
	for _, c := range cases {
		got := p.Check(c.cmd)
		if (got != nil) != c.deny {
			t.Errorf("%s: denied=%v, want %v (%v)", c.name, got != nil, c.deny, got)
		}
	}
}

func TestReadOnlyAllowsOnlyTheDiagnosticRefresh(t *testing.T) {
	p := Default()
	p.ReadOnly = true
	if d := p.Check(&pb.Command{Op: &pb.Command_RefreshStatus{}}); d != nil {
		t.Errorf("refresh must work read-only, it is how the UI learns the Velero version: %v", d)
	}
	for name, cmd := range map[string]*pb.Command{
		"backup":   {Op: &pb.Command_CreateBackup{}},
		"restore":  restore(&pb.RestoreSpec{IncludedNamespaces: []string{"shop"}}),
		"schedule": {Op: &pb.Command_CreateSchedule{}},
		"delete":   {Op: &pb.Command_DeleteBackup{}},
		"bsl":      {Op: &pb.Command_UpsertBsl{}},
		"empty":    {},
	} {
		if d := p.Check(cmd); d == nil || !strings.Contains(d.Reason, "read-only") {
			t.Errorf("%s was not refused read-only: %v", name, d)
		}
	}
}

func TestAllowFlagsGateTheirOperations(t *testing.T) {
	p := Default()
	p.AllowRestore = false
	p.AllowBslWrite = false
	if p.Check(restore(&pb.RestoreSpec{IncludedNamespaces: []string{"shop"}})) == nil {
		t.Error("restore allowed with allowRestore=false")
	}
	for name, cmd := range map[string]*pb.Command{
		"upsert bsl":  {Op: &pb.Command_UpsertBsl{}},
		"default bsl": {Op: &pb.Command_SetDefaultBsl{}},
		"delete bsl":  {Op: &pb.Command_DeleteBsl{}},
		"upsert vsl":  {Op: &pb.Command_UpsertVsl{}},
		"delete vsl":  {Op: &pb.Command_DeleteVsl{}},
	} {
		if p.Check(cmd) == nil {
			t.Errorf("%s allowed with allowBslWrite=false", name)
		}
	}
	if p.Check(&pb.Command{Op: &pb.Command_CreateBackup{}}) != nil {
		t.Error("a backup is not a storage change and not a restore")
	}
}

func TestParseAcceptsListsInEveryFormAndRejectsMistakes(t *testing.T) {
	for _, in := range []string{`["a","b"]`, `[a, b]`, `a,b`, ` a , b `} {
		p, err := Parse(map[string]string{"restoreDeniedNamespaces": in})
		if err != nil || len(p.RestoreDeniedNamespaces) != 2 || p.RestoreDeniedNamespaces[0] != "a" || p.RestoreDeniedNamespaces[1] != "b" {
			t.Errorf("list %q parsed as %v, %v", in, p.RestoreDeniedNamespaces, err)
		}
	}
	if p, err := Parse(map[string]string{"restoreDeniedNamespaces": "[]"}); err != nil || len(p.RestoreDeniedNamespaces) != 0 {
		t.Errorf("an explicit empty list must stay empty (the owner chose to protect nothing): %v %v", p.RestoreDeniedNamespaces, err)
	}

	p, err := Parse(nil)
	if err != nil || !p.AllowRestore || len(p.RestoreDeniedNamespaces) != 3 {
		t.Errorf("no keys must give the default: %+v %v", p, err)
	}

	for name, data := range map[string]map[string]string{
		"a typo in a key":  {"allowRestor": "false"},
		"a non-boolean":    {"readOnly": "yes please"},
		"an overlong name": {"restoreDeniedNamespaces": strings.Repeat("x", 64)},
		"several mistakes": {"nope": "1", "allowBslWrite": "maybe"},
	} {
		got, err := Parse(data)
		if err == nil {
			t.Errorf("%s was accepted", name)
		}
		if !got.ReadOnly || got.AllowRestore || got.AllowBslWrite {
			t.Errorf("%s did not fail closed: %+v", name, got)
		}
	}
}

func TestLockdownRefusesEverythingThatChangesAnything(t *testing.T) {
	p := Lockdown()
	if p.Check(restore(&pb.RestoreSpec{IncludedNamespaces: []string{"shop"}})) == nil ||
		p.Check(&pb.Command{Op: &pb.Command_CreateBackup{}}) == nil ||
		p.Check(&pb.Command{Op: &pb.Command_UpsertBsl{}}) == nil {
		t.Error("lockdown allowed a mutation")
	}
	if p.Check(&pb.Command{Op: &pb.Command_RefreshStatus{}}) != nil {
		t.Error("lockdown must still allow the diagnostic refresh")
	}
	if p.CheckLogSession("shop") == nil {
		t.Error("lockdown allowed log streaming")
	}
}

func TestLogSessionRules(t *testing.T) {
	p := Default()
	p.LogStreamDeniedNamespaces = []string{"payments"}
	if p.CheckLogSession("shop") != nil {
		t.Error("an ordinary namespace was refused")
	}
	if p.CheckLogSession("payments") == nil {
		t.Error("a denied namespace was allowed")
	}
	p.AllowLogStreaming = false
	if p.CheckLogSession("shop") == nil {
		t.Error("allowLogStreaming=false was ignored")
	}
}

func TestLoadDefaultsWhenAbsentAndLocksDownWhenBroken(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset()
	p, err := Load(ctx, cs, "vfm-system", "vfm-agent-policy")
	if err != nil || !p.AllowRestore {
		t.Fatalf("a missing ConfigMap must mean the default: %+v %v", p, err)
	}

	_, _ = cs.CoreV1().ConfigMaps("vfm-system").Create(ctx, &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "vfm-agent-policy", Namespace: "vfm-system"},
		Data:       map[string]string{"allowRestore": "false", "restoreDeniedNamespaces": "[prod]"},
	}, metav1.CreateOptions{})
	p, err = Load(ctx, cs, "vfm-system", "vfm-agent-policy")
	if err != nil || p.AllowRestore || p.RestoreDeniedNamespaces[0] != "prod" {
		t.Fatalf("policy not read: %+v %v", p, err)
	}

	_, _ = cs.CoreV1().ConfigMaps("vfm-system").Update(ctx, &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "vfm-agent-policy", Namespace: "vfm-system"},
		Data:       map[string]string{"readOnyl": "true"},
	}, metav1.UpdateOptions{})
	p, err = Load(ctx, cs, "vfm-system", "vfm-agent-policy")
	if err == nil || !p.ReadOnly {
		t.Fatalf("a broken ConfigMap must lock the agent down and say why: %+v %v", p, err)
	}
}

func TestProtoReportsThePolicyWithoutAliasing(t *testing.T) {
	p := Default()
	msg := p.Proto()
	msg.RestoreDeniedNamespaces[0] = "tampered"
	if p.RestoreDeniedNamespaces[0] == "tampered" {
		t.Error("Proto() shares memory with the policy")
	}
	if !msg.GetAllowRestore() {
		t.Error("policy not reported")
	}
}
