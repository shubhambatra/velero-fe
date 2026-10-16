package velero

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	kubefake "k8s.io/client-go/kubernetes/fake"
	clienttesting "k8s.io/client-go/testing"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

func nsObject(name string, phase corev1.NamespacePhase) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}, Status: corev1.NamespaceStatus{Phase: phase}}
}

func checkCmd(names ...string) *pb.Command {
	return &pb.Command{CommandId: cmdID, Op: &pb.Command_CheckNamespaces{CheckNamespaces: &pb.CheckNamespaces{Names: names}}}
}

func TestReportsWhichOfTheAskedNamespacesExist(t *testing.T) {
	client := kubefake.NewSimpleClientset(nsObject("shop", corev1.NamespaceActive), nsObject("going", corev1.NamespaceTerminating), nsObject("secret-other", corev1.NamespaceActive))
	res := (&NamespaceChecker{Client: client}).Check(context.Background(), checkCmd("shop", "new-ns", "going", "shop"))

	if !res.GetOk() {
		t.Fatalf("%v", res)
	}
	got := res.GetNamespaces().GetNamespaces()
	if len(got) != 3 {
		t.Fatalf("a repeated name is reported once, in the order asked: %v", got)
	}
	want := []struct {
		name        string
		exists, end bool
	}{{"shop", true, false}, {"new-ns", false, false}, {"going", true, true}}
	for i, w := range want {
		if got[i].GetName() != w.name || got[i].GetExists() != w.exists || got[i].GetTerminating() != w.end {
			t.Errorf("%d: %v", i, got[i])
		}
	}
	for _, n := range got {
		if n.GetName() == "secret-other" {
			t.Fatal("a namespace nobody asked about was reported")
		}
	}
}

func TestNeverListsNamespaces(t *testing.T) {
	client := kubefake.NewSimpleClientset(nsObject("shop", corev1.NamespaceActive))
	(&NamespaceChecker{Client: client}).Check(context.Background(), checkCmd("shop"))
	for _, a := range client.Actions() {
		if a.GetVerb() != "get" {
			t.Fatalf("only single reads are allowed, saw %s", a.GetVerb())
		}
	}
}

func TestRefusesBadAndTooManyNames(t *testing.T) {
	client := kubefake.NewSimpleClientset()
	h := &NamespaceChecker{Client: client}
	for _, asked := range [][]string{{"Bad"}, {"a/b"}, {""}, {"-x"}, names(MaxNamespacesChecked + 1)} {
		if res := h.Check(context.Background(), checkCmd(asked...)); res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT {
			t.Errorf("%v: %v", asked, res)
		}
	}
	if len(client.Actions()) != 0 {
		t.Fatalf("a refused request must not touch the cluster: %v", client.Actions())
	}
	if res := h.Check(context.Background(), checkCmd(names(MaxNamespacesChecked)...)); !res.GetOk() {
		t.Fatalf("exactly the limit is fine: %v", res)
	}
}

func names(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = "ns-" + strings.Repeat("a", i+1)
	}
	return out
}

func TestAnAPIFailureIsTypedWithoutTheBody(t *testing.T) {
	client := kubefake.NewSimpleClientset()
	client.PrependReactor("get", "namespaces", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, &forbidden{}
	})
	res := (&NamespaceChecker{Client: client}).Check(context.Background(), checkCmd("shop"))
	if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR || strings.Contains(res.GetErrorMessage(), "secret-detail") {
		t.Fatalf("%v", res)
	}
}

func TestAnEmptyRequestIsAnEmptyReport(t *testing.T) {
	res := (&NamespaceChecker{Client: kubefake.NewSimpleClientset()}).Check(context.Background(), checkCmd())
	if !res.GetOk() || len(res.GetNamespaces().GetNamespaces()) != 0 {
		t.Fatalf("%v", res)
	}
}
