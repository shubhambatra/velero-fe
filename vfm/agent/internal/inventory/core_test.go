package inventory

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

const leak = "SECRET-VALUE-from-a-pod-spec"

func pod(ns, name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{
			"name": name, "namespace": ns, "uid": "uid-" + name, "resourceVersion": "1",
			"creationTimestamp": "2026-10-16T05:00:00Z",
			"labels":            map[string]any{"app": leak},
			"annotations":       map[string]any{"vault.hashicorp.com/token": leak},
			"ownerReferences":   []any{map[string]any{"kind": "ReplicaSet", "name": "web-abc", "controller": true}},
		},
		"spec": map[string]any{
			"nodeName": "node-1",
			"containers": []any{
				map[string]any{"name": "app", "image": "nginx:1", "env": []any{map[string]any{"name": "DB_PASSWORD", "value": leak}}},
				map[string]any{"name": "side", "image": "envoy:1", "command": []any{leak}},
			},
			"volumes": []any{map[string]any{"name": "creds", "secret": map[string]any{"secretName": leak}}},
		},
		"status": map[string]any{
			"phase": "Running", "startTime": "2026-10-16T05:00:05Z",
			"containerStatuses": []any{
				map[string]any{"name": "app", "image": "nginx:1", "ready": true, "restartCount": int64(2),
					"state":     map[string]any{"running": map[string]any{"startedAt": "2026-10-16T05:00:06Z"}},
					"lastState": map[string]any{"terminated": map[string]any{"reason": "OOMKilled", "message": leak}}},
				map[string]any{"name": "side", "image": "envoy:1", "ready": false, "restartCount": int64(1),
					"state": map[string]any{"waiting": map[string]any{"reason": "CrashLoopBackOff", "message": leak}}},
			},
		},
	}}
}

func TestAPodIsReportedAsASummaryAndNothingElse(t *testing.T) {
	out := projectPod(pod("shop", "web-1"))
	raw, _ := json.Marshal(out.Object)
	for _, forbidden := range []string{leak, "DB_PASSWORD", `"env"`, "volumes", "annotations", "labels", "command", "message"} {
		if strings.Contains(string(raw), forbidden) {
			t.Errorf("the projection of a pod carries %q: %s", forbidden, raw)
		}
	}
	status := out.Object["status"].(map[string]any)
	if status["phase"] != "Running" || status["readyCount"] != int64(1) || status["containerCount"] != int64(2) || status["restartCount"] != int64(3) {
		t.Errorf("summary wrong: %v", status)
	}
	containers := status["containerStatuses"].([]any)
	first, second := containers[0].(map[string]any), containers[1].(map[string]any)
	if first["state"] != "running" || first["lastTerminationReason"] != "OOMKilled" || second["state"] != "waiting" || second["reason"] != "CrashLoopBackOff" {
		t.Errorf("container states wrong: %v %v", first, second)
	}
	spec := out.Object["spec"].(map[string]any)
	if spec["nodeName"] != "node-1" || spec["owner"].(map[string]any)["name"] != "web-abc" {
		t.Errorf("spec wrong: %v", spec)
	}
	if status["startTimestamp"] != "2026-10-16T05:00:05Z" {
		t.Errorf("start time wrong: %v", status["startTimestamp"])
	}
}

func TestNodesNamespacesAndClaimsKeepOnlyWhatTheViewShows(t *testing.T) {
	node := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Node",
		"metadata": map[string]any{"name": "n1", "uid": "uid-n1", "labels": map[string]any{"node-role.kubernetes.io/control-plane": ""}, "annotations": map[string]any{"x": leak}},
		"spec":     map[string]any{"unschedulable": true, "taints": []any{map[string]any{"key": "dedicated", "value": "db", "effect": "NoSchedule"}}, "providerID": leak},
		"status": map[string]any{
			"conditions":  []any{map[string]any{"type": "Ready", "status": "True"}, map[string]any{"type": "MemoryPressure", "status": "False", "message": leak}},
			"allocatable": map[string]any{"cpu": "4", "memory": "16Gi", "pods": "110"},
			"nodeInfo":    map[string]any{"kubeletVersion": "v1.31.0", "machineID": leak},
			"images":      []any{map[string]any{"names": []any{leak}}},
		},
	}}
	out := projectNode(node)
	raw, _ := json.Marshal(out.Object)
	if strings.Contains(string(raw), leak) {
		t.Errorf("a node projection carries something it should not: %s", raw)
	}
	status := out.Object["status"].(map[string]any)
	if status["phase"] != "Ready" || status["allocatable"].(map[string]any)["memory"] != "16Gi" ||
		status["nodeInfo"].(map[string]any)["kubeletVersion"] != "v1.31.0" {
		t.Errorf("node status wrong: %v", status)
	}

	notReady := node.DeepCopy()
	_ = unstructured.SetNestedSlice(notReady.Object, []any{map[string]any{"type": "Ready", "status": "False"}}, "status", "conditions")
	if projectNode(notReady).Object["status"].(map[string]any)["phase"] != "NotReady" {
		t.Error("a node that is not ready was reported ready")
	}

	pvc := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "PersistentVolumeClaim",
		"metadata": map[string]any{"name": "data", "namespace": "shop", "uid": "uid-pvc", "annotations": map[string]any{"x": leak}},
		"spec":     map[string]any{"storageClassName": "fast", "volumeName": "pv-1", "resources": map[string]any{"requests": map[string]any{"storage": leak}}},
		"status":   map[string]any{"phase": "Bound", "capacity": map[string]any{"storage": "10Gi"}},
	}}
	raw, _ = json.Marshal(projectPVC(pvc).Object)
	if strings.Contains(string(raw), leak) || !strings.Contains(string(raw), `"volumeName":"pv-1"`) || !strings.Contains(string(raw), "10Gi") {
		t.Errorf("pvc projection wrong: %s", raw)
	}
}

func event(name, typ, apiVersion, last string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Event", "type": typ, "reason": "BackOff", "message": "Back-off restarting failed container",
		"lastTimestamp": last, "count": int64(3),
		"involvedObject": map[string]any{"kind": "Pod", "name": "web-1", "namespace": "shop", "apiVersion": apiVersion},
		"metadata":       map[string]any{"name": name, "namespace": "shop", "uid": "uid-" + name, "creationTimestamp": last},
	}}
}

func TestEventsAreWarningsOrVeleroOnesFromTheLastHour(t *testing.T) {
	now = func() time.Time { return time.Date(2026, 10, 16, 6, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { now = time.Now })
	recent, old := "2026-10-16T05:30:00Z", "2026-10-16T04:30:00Z"
	for name, c := range map[string]struct {
		obj  *unstructured.Unstructured
		want bool
	}{
		"a recent warning":              {event("e1", "Warning", "v1", recent), true},
		"a recent normal event":         {event("e2", "Normal", "v1", recent), false},
		"a recent normal Velero event":  {event("e3", "Normal", "velero.io/v1", recent), true},
		"a warning from two hours back": {event("e4", "Warning", "v1", old), false},
		"an event with no usable time":  {event("e5", "Warning", "v1", "garbage"), false},
	} {
		if got := projectEvent(c.obj) != nil; got != c.want {
			t.Errorf("%s: reported=%v, want %v", name, got, c.want)
		}
	}
	out := projectEvent(event("e1", "Warning", "v1", recent))
	status := out.Object["status"].(map[string]any)
	if status["phase"] != "Warning" || status["reason"] != "BackOff" || status["count"] != int64(3) || status["startTimestamp"] != recent {
		t.Errorf("event wrong: %v", status)
	}
}

// coreCluster is a cluster that serves the core kinds.
func coreCluster(objs ...runtime.Object) *cluster {
	list := map[schema.GroupVersionResource]string{}
	for _, k := range append(append([]Kind{}, VeleroKinds...), CoreKinds...) {
		list[k.GVR] = "List"
	}
	c := newCluster(v1)
	c.dyn = dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), list, objs...)
	res := &metav1.APIResourceList{GroupVersion: "v1"}
	for _, k := range CoreKinds {
		res.APIResources = append(res.APIResources, metav1.APIResource{Name: k.GVR.Resource, Namespaced: !k.Cluster})
	}
	c.disc.Resources = append(c.disc.Resources, res)
	return c
}

func coreOptions(c *cluster, s *sink) Options {
	o := fastOptions(c, s)
	o.Core = true
	return o
}

func kindsOf(chunks []*pb.InventorySnapshot) map[pb.ResourceKind][]string {
	out := map[pb.ResourceKind][]string{}
	for _, c := range chunks {
		for _, it := range c.GetItems() {
			out[it.GetKind()] = append(out[it.GetKind()], it.GetNamespace()+"/"+it.GetName())
		}
	}
	return out
}

func TestTheSnapshotCarriesTheLiveViewAcrossEveryNamespace(t *testing.T) {
	now = func() time.Time { return time.Date(2026, 10, 16, 6, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { now = time.Now })
	ns := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "Namespace",
		"metadata": map[string]any{"name": "shop", "uid": "uid-ns"}, "status": map[string]any{"phase": "Active"}}}
	c := coreCluster(ns, pod("shop", "web-1"), pod("kube-system", "dns-1"),
		event("warn", "Warning", "v1", "2026-10-16T05:50:00Z"), event("chatter", "Normal", "v1", "2026-10-16T05:50:00Z"))
	s := &sink{}
	sy0 := start(t, coreOptions(c, s))
	sy0.SetConnected(true)
	sy := s
	var id string
	eventually(t, "a complete snapshot", func() bool {
		order, _ := sy.snapshots()
		if len(order) == 0 {
			return false
		}
		id = order[0]
		return complete(sy, id)
	})
	_, by := s.snapshots()
	got := kindsOf(by[id])
	if len(got[pb.ResourceKind_RESOURCE_KIND_POD]) != 2 {
		t.Errorf("pods from every namespace expected: %v", got)
	}
	if len(got[pb.ResourceKind_RESOURCE_KIND_NAMESPACE]) != 1 {
		t.Errorf("the namespace is missing: %v", got)
	}
	if ev := got[pb.ResourceKind_RESOURCE_KIND_EVENT]; len(ev) != 1 || ev[0] != "shop/warn" {
		t.Errorf("only the warning is reported: %v", ev)
	}
	for _, chunk := range by[id] {
		for _, it := range chunk.GetItems() {
			if strings.Contains(string(it.GetObjectJson()), leak) {
				t.Errorf("a reported object carries the secret: %s", it.GetObjectJson())
			}
		}
	}
}

func TestInALargeClusterPodsAreReportedOnlyForTheAskedForNamespaces(t *testing.T) {
	c := coreCluster(pod("a", "p1"), pod("b", "p2"), pod("c", "p3"))
	s := &sink{}
	opts := coreOptions(c, s)
	opts.PodScopeThreshold = 2 // three pods is a large cluster
	sy := start(t, opts)
	sy.SetConnected(true)

	podsIn := func(id string) []string {
		_, by := s.snapshots()
		return kindsOf(by[id])[pb.ResourceKind_RESOURCE_KIND_POD]
	}
	latest := func() string {
		order, _ := s.snapshots()
		if len(order) == 0 {
			return ""
		}
		return order[len(order)-1]
	}
	eventually(t, "the first snapshot", func() bool { return latest() != "" && complete(s, latest()) })
	if got := podsIn(latest()); len(got) != 0 {
		t.Errorf("with no scope given a large cluster reports no pods: %v", got)
	}

	before := latest()
	sy.HandleServerMessage(&pb.ServerMessage{Payload: &pb.ServerMessage_WatchScope{WatchScope: &pb.WatchScope{PodNamespaces: []string{"b"}}}})
	eventually(t, "a snapshot after the scope changed", func() bool { return latest() != before && complete(s, latest()) })
	if got := podsIn(latest()); len(got) != 1 || got[0] != "b/p2" {
		t.Errorf("only namespace b was asked for: %v", got)
	}
}

func TestASmallClusterReportsEveryPodWhateverItIsToldAbout(t *testing.T) {
	c := coreCluster(pod("a", "p1"), pod("b", "p2"))
	s := &sink{}
	sy := start(t, coreOptions(c, s))
	sy.SetConnected(true)
	sy.HandleServerMessage(&pb.ServerMessage{Payload: &pb.ServerMessage_WatchScope{WatchScope: &pb.WatchScope{PodNamespaces: []string{"a"}}}})
	eventually(t, "a snapshot", func() bool { o, _ := s.snapshots(); return len(o) > 0 && complete(s, o[len(o)-1]) })
	o, by := s.snapshots()
	if got := kindsOf(by[o[len(o)-1]])[pb.ResourceKind_RESOURCE_KIND_POD]; len(got) != 2 {
		t.Errorf("below the threshold every pod is reported: %v", got)
	}
}

func TestAnEventThatStopsQualifyingIsRetiredOnceAndOnlyOnce(t *testing.T) {
	now = func() time.Time { return time.Date(2026, 10, 16, 6, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { now = time.Now })
	c := coreCluster(event("ev", "Warning", "v1", "2026-10-16T05:50:00Z"))
	s := &sink{}
	start(t, coreOptions(c, s)).SetConnected(true)
	eventually(t, "a snapshot", func() bool { o, _ := s.snapshots(); return len(o) > 0 && complete(s, o[0]) })

	evRes := c.dyn.Resource(core.WithResource("events")).Namespace("shop")
	// It is updated into a Normal event: no longer of interest, so the control plane is told to drop it.
	upd := event("ev", "Normal", "v1", "2026-10-16T05:50:00Z")
	upd.SetResourceVersion("2")
	if _, err := evRes.Update(context.Background(), upd, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	deletes := func() int {
		n := 0
		for _, b := range s.batches() {
			for _, e := range b.GetEvents() {
				if e.GetType() == pb.ResourceEventType_RESOURCE_EVENT_TYPE_DELETE && e.GetItem().GetName() == "ev" {
					n++
				}
			}
		}
		return n
	}
	eventually(t, "the retirement", func() bool { return deletes() == 1 })

	upd2 := upd.DeepCopy()
	upd2.SetResourceVersion("3")
	if _, err := evRes.Update(context.Background(), upd2, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if deletes() != 1 {
		t.Errorf("the same retirement was sent %d times", deletes())
	}
}
