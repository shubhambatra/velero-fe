package velero

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

const cmdID = "0194f9d2-0000-7000-8000-00000000c001"

func newClient() *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{serverStatusRequests: "ServerStatusRequestList"})
}

func command() *pb.Command {
	return &pb.Command{CommandId: cmdID, RequestedBy: "0194f9d2-0000-7000-8000-0000000000aa",
		Op: &pb.Command_RefreshStatus{RefreshStatus: &pb.RefreshServerStatus{}}}
}

// processedAfter makes the fake behave like Velero: the request becomes
// `Processed` with a version and plugins after `gets` reads.
func processedAfter(c *dynamicfake.FakeDynamicClient, gets int32) {
	var n atomic.Int32
	c.PrependReactor("get", "serverstatusrequests", func(action clienttesting.Action) (bool, runtime.Object, error) {
		ga := action.(clienttesting.GetAction)
		obj, err := c.Tracker().Get(serverStatusRequests, ga.GetNamespace(), ga.GetName())
		if err != nil {
			return true, nil, err
		}
		u := obj.(*unstructured.Unstructured).DeepCopy()
		if n.Add(1) > gets {
			_ = unstructured.SetNestedField(u.Object, "Processed", "status", "phase")
			_ = unstructured.SetNestedField(u.Object, "v1.18.4", "status", "serverVersion")
			_ = unstructured.SetNestedSlice(u.Object, []any{
				map[string]any{"name": "velero.io/aws", "kind": "ObjectStore"},
				map[string]any{"name": "velero.io/csi", "kind": "BackupItemAction"},
			}, "status", "plugins")
		}
		return true, u, nil
	})
}

func handler(c *dynamicfake.FakeDynamicClient) *StatusHandler {
	return &StatusHandler{Dynamic: c, Namespace: "velero", PollInterval: 5 * time.Millisecond}
}

func TestReadsVersionAndPluginsOnceVeleroHasProcessedTheRequest(t *testing.T) {
	c := newClient()
	processedAfter(c, 3)

	res := handler(c).Handle(context.Background(), command())

	if !res.GetOk() {
		t.Fatalf("not ok: %v", res)
	}
	s := res.GetServerStatus()
	if s.GetServerVersion() != "v1.18.4" || len(s.GetPlugins()) != 2 || s.GetPlugins()[0].GetName() != "velero.io/aws" {
		t.Errorf("status = %v", s)
	}
	if s.GetProcessedAt() == nil {
		t.Error("no processed time")
	}
}

func TestTheRequestIsLabelledForTraceabilityAndRemovedAfterwards(t *testing.T) {
	c := newClient()
	processedAfter(c, 0)
	var created *unstructured.Unstructured
	c.PrependReactor("create", "serverstatusrequests", func(a clienttesting.Action) (bool, runtime.Object, error) {
		created = a.(clienttesting.CreateAction).GetObject().(*unstructured.Unstructured).DeepCopy()
		return false, nil, nil
	})

	handler(c).Handle(context.Background(), command())

	if created == nil {
		t.Fatal("no request was created")
	}
	labels := created.GetLabels()
	if labels[LabelCommandID] != cmdID || labels[LabelRequestedBy] != "0194f9d2-0000-7000-8000-0000000000aa" {
		t.Errorf("labels = %v", labels)
	}
	if created.GetAnnotations()[AnnotationManaged] != "true" {
		t.Errorf("annotations = %v", created.GetAnnotations())
	}
	if created.GetNamespace() != "velero" {
		t.Errorf("namespace = %q", created.GetNamespace())
	}
	list, _ := c.Resource(serverStatusRequests).Namespace("velero").List(context.Background(), metav1.ListOptions{})
	if len(list.Items) != 0 {
		t.Errorf("%d request(s) left behind in the customer's cluster", len(list.Items))
	}
}

func TestAnExistingRequestForTheSameCommandIsReusedNotDuplicated(t *testing.T) {
	c := newClient()
	existing := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "velero.io/v1", "kind": "ServerStatusRequest",
		"metadata": map[string]any{
			"name": "left-by-a-previous-run", "namespace": "velero",
			"labels": map[string]any{LabelCommandID: cmdID},
		},
		"spec": map[string]any{},
	}}
	if _, err := c.Resource(serverStatusRequests).Namespace("velero").Create(context.Background(), existing, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	processedAfter(c, 0)
	var creates atomic.Int32
	c.PrependReactor("create", "serverstatusrequests", func(clienttesting.Action) (bool, runtime.Object, error) {
		creates.Add(1)
		return false, nil, nil
	})

	if res := handler(c).Handle(context.Background(), command()); !res.GetOk() {
		t.Fatalf("not ok: %v", res)
	}
	if creates.Load() != 0 {
		t.Error("a second object was created for the same command id")
	}
}

func TestAnInvalidRequestedByIsOmittedRatherThanBreakingTheObject(t *testing.T) {
	c := newClient()
	processedAfter(c, 0)
	var created *unstructured.Unstructured
	c.PrependReactor("create", "serverstatusrequests", func(a clienttesting.Action) (bool, runtime.Object, error) {
		created = a.(clienttesting.CreateAction).GetObject().(*unstructured.Unstructured).DeepCopy()
		return false, nil, nil
	})
	cmd := command()
	cmd.RequestedBy = "not a valid label value!!"

	handler(c).Handle(context.Background(), cmd)

	if _, present := created.GetLabels()[LabelRequestedBy]; present {
		t.Error("an invalid label value was sent to the API server")
	}
	if created.GetLabels()[LabelCommandID] != cmdID {
		t.Error("the command id label is the idempotency key and must always be set")
	}
}

func TestVeleroNotBeingInstalledIsReportedPlainly(t *testing.T) {
	c := newClient()
	c.PrependReactor("list", "serverstatusrequests", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, &meta.NoKindMatchError{GroupKind: schema.GroupKind{Group: "velero.io", Kind: "ServerStatusRequest"}}
	})

	res := handler(c).Handle(context.Background(), command())

	if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_NOT_FOUND {
		t.Fatalf("want NOT_FOUND, got %v", res)
	}
}

func TestAForbiddenAPICallDoesNotLeakTheAPIBody(t *testing.T) {
	c := newClient()
	c.PrependReactor("list", "serverstatusrequests", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(serverStatusRequests.GroupResource(), "secret-object-name", nil)
	})

	res := handler(c).Handle(context.Background(), command())

	if res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_KUBE_API_ERROR {
		t.Fatalf("want KUBE_API_ERROR, got %v", res)
	}
	if contains(res.GetErrorMessage(), "secret-object-name") {
		t.Errorf("the raw API error leaked: %q", res.GetErrorMessage())
	}
}

func TestAVeleroThatNeverAnswersEndsInATimeoutAndStillCleansUp(t *testing.T) {
	c := newClient() // no reactor: the request never becomes Processed
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()

	res := handler(c).Handle(ctx, command())

	if res.GetOk() || res.GetErrorCode() != pb.ErrorCode_ERROR_CODE_TIMEOUT {
		t.Fatalf("want TIMEOUT, got %v", res)
	}
	list, _ := c.Resource(serverStatusRequests).Namespace("velero").List(context.Background(), metav1.ListOptions{})
	if len(list.Items) != 0 {
		t.Error("the unanswered request was left behind")
	}
}

func TestPluginCountAndShapeAreBounded(t *testing.T) {
	c := newClient()
	c.PrependReactor("get", "serverstatusrequests", func(action clienttesting.Action) (bool, runtime.Object, error) {
		ga := action.(clienttesting.GetAction)
		obj, _ := c.Tracker().Get(serverStatusRequests, ga.GetNamespace(), ga.GetName())
		u := obj.(*unstructured.Unstructured).DeepCopy()
		many := make([]any, 0, 500)
		for range 500 {
			many = append(many, map[string]any{"name": "p", "kind": "k"})
		}
		many = append(many, "not-a-map", int64(42), nil)
		// Built directly: the typed setters refuse exactly the hostile shapes
		// this test wants a misbehaving cluster to return.
		u.Object["status"] = map[string]any{"phase": "Processed", "plugins": many}
		return true, u, nil
	})

	res := handler(c).Handle(context.Background(), command())

	if !res.GetOk() || len(res.GetServerStatus().GetPlugins()) != maxPlugins {
		t.Fatalf("plugins = %d, want %d", len(res.GetServerStatus().GetPlugins()), maxPlugins)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
