package inventory

import (
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// The core Kubernetes kinds of PLAN.md §7.1. Unlike Velero's, they are watched across
// the whole cluster, and what is reported is a **projection**: a new object that holds
// only the fields on an allowlist. Nothing is deleted from the real object to get there;
// the projection is built from nothing, so a field nobody listed (a Pod's env vars and
// specs, a node's annotations) cannot leak by being forgotten. Pods especially: their
// specs and annotations routinely carry secrets.

var core = schema.GroupVersion{Group: "", Version: "v1"}

// CoreKinds are the kinds of the live view.
var CoreKinds = []Kind{
	{Proto: pb.ResourceKind_RESOURCE_KIND_NODE, GVR: core.WithResource("nodes"), Cluster: true, Project: projectNode},
	{Proto: pb.ResourceKind_RESOURCE_KIND_NAMESPACE, GVR: core.WithResource("namespaces"), Cluster: true, Project: projectNamespace},
	{Proto: pb.ResourceKind_RESOURCE_KIND_POD, GVR: core.WithResource("pods"), Cluster: true, Project: projectPod},
	{Proto: pb.ResourceKind_RESOURCE_KIND_PERSISTENT_VOLUME_CLAIM, GVR: core.WithResource("persistentvolumeclaims"), Cluster: true, Project: projectPVC},
	{Proto: pb.ResourceKind_RESOURCE_KIND_EVENT, GVR: core.WithResource("events"), Cluster: true, Project: projectEvent},
}

// EventWindow is how far back an event is still interesting (PLAN.md §7.1).
const EventWindow = time.Hour

// now is replaceable so tests need not wait an hour.
var now = time.Now

const (
	maxMessage = 512
	maxText    = 253
	maxLabels  = 32
	maxTaints  = 16
)

func str(obj map[string]any, path ...string) string {
	v, _, _ := unstructured.NestedString(obj, path...)
	return v
}

func clip(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, s)
	if len(s) > n {
		return s[:n]
	}
	return s
}

// base is the metadata every projection carries.
func base(obj *unstructured.Unstructured, apiKind string, labels bool) map[string]any {
	meta := map[string]any{
		"name": obj.GetName(),
		"uid":  string(obj.GetUID()),
	}
	if ns := obj.GetNamespace(); ns != "" {
		meta["namespace"] = ns
	}
	if ts := obj.GetCreationTimestamp(); !ts.IsZero() {
		meta["creationTimestamp"] = ts.UTC().Format(time.RFC3339)
	}
	if labels {
		out := map[string]any{}
		for k, v := range obj.GetLabels() {
			if len(out) >= maxLabels {
				break
			}
			out[clip(k, maxText)] = clip(v, 63)
		}
		if len(out) > 0 {
			meta["labels"] = out
		}
	}
	return map[string]any{"apiVersion": "v1", "kind": apiKind, "metadata": meta}
}

func projectNamespace(obj *unstructured.Unstructured) *unstructured.Unstructured {
	out := base(obj, "Namespace", true)
	out["status"] = map[string]any{"phase": str(obj.Object, "status", "phase")}
	return &unstructured.Unstructured{Object: out}
}

func projectNode(obj *unstructured.Unstructured) *unstructured.Unstructured {
	out := base(obj, "Node", true)

	ready := "Unknown"
	var conditions []any
	list, _, _ := unstructured.NestedSlice(obj.Object, "status", "conditions")
	for _, c := range list {
		m, _ := c.(map[string]any)
		typ, status := str(m, "type"), str(m, "status")
		if typ == "" {
			continue
		}
		if typ == "Ready" {
			ready = map[string]string{"True": "Ready", "False": "NotReady"}[status]
			if ready == "" {
				ready = "Unknown"
			}
		}
		conditions = append(conditions, map[string]any{"type": clip(typ, 64), "status": clip(status, 16), "reason": clip(str(m, "reason"), 64)})
	}

	status := map[string]any{"phase": ready}
	if len(conditions) > 0 {
		status["conditions"] = conditions
	}
	alloc := map[string]any{}
	for _, k := range []string{"cpu", "memory", "pods"} {
		if v := str(obj.Object, "status", "allocatable", k); v != "" {
			alloc[k] = clip(v, 32)
		}
	}
	status["allocatable"] = alloc
	status["nodeInfo"] = map[string]any{"kubeletVersion": clip(str(obj.Object, "status", "nodeInfo", "kubeletVersion"), 64)}
	out["status"] = status

	spec := map[string]any{}
	if unsched, _, _ := unstructured.NestedBool(obj.Object, "spec", "unschedulable"); unsched {
		spec["unschedulable"] = true
	}
	taints, _, _ := unstructured.NestedSlice(obj.Object, "spec", "taints")
	var outTaints []any
	for _, t := range taints {
		if m, ok := t.(map[string]any); ok && len(outTaints) < maxTaints {
			outTaints = append(outTaints, map[string]any{
				"key": clip(str(m, "key"), maxText), "value": clip(str(m, "value"), 63), "effect": clip(str(m, "effect"), 32),
			})
		}
	}
	if len(outTaints) > 0 {
		spec["taints"] = outTaints
	}
	out["spec"] = spec
	return &unstructured.Unstructured{Object: out}
}

func projectPVC(obj *unstructured.Unstructured) *unstructured.Unstructured {
	out := base(obj, "PersistentVolumeClaim", false)
	out["spec"] = map[string]any{
		"storageClassName": clip(str(obj.Object, "spec", "storageClassName"), maxText),
		"volumeName":       clip(str(obj.Object, "spec", "volumeName"), maxText),
	}
	out["status"] = map[string]any{
		"phase":    str(obj.Object, "status", "phase"),
		"capacity": map[string]any{"storage": clip(str(obj.Object, "status", "capacity", "storage"), 32)},
	}
	return &unstructured.Unstructured{Object: out}
}

// projectPod keeps the summary of PLAN.md §7.1 and nothing else: no env vars, no specs,
// no annotations, no labels.
func projectPod(obj *unstructured.Unstructured) *unstructured.Unstructured {
	out := base(obj, "Pod", false)

	spec := map[string]any{"nodeName": clip(str(obj.Object, "spec", "nodeName"), maxText)}
	owners, _, _ := unstructured.NestedSlice(obj.Object, "metadata", "ownerReferences")
	for _, o := range owners {
		m, _ := o.(map[string]any)
		if controller, _ := m["controller"].(bool); controller || len(owners) == 1 {
			spec["owner"] = map[string]any{"kind": clip(str(m, "kind"), 63), "name": clip(str(m, "name"), maxText)}
			break
		}
	}
	out["spec"] = spec

	var containers []any
	ready, restarts := 0, int64(0)
	for _, key := range []string{"initContainerStatuses", "containerStatuses"} {
		list, _, _ := unstructured.NestedSlice(obj.Object, "status", key)
		for _, c := range list {
			m, _ := c.(map[string]any)
			state, reason := containerState(m)
			count, _, _ := unstructured.NestedInt64(m, "restartCount")
			isReady, _ := m["ready"].(bool)
			entry := map[string]any{
				"name": clip(str(m, "name"), 63), "image": clip(str(m, "image"), maxText),
				"ready": isReady, "state": state, "reason": clip(reason, 64), "restartCount": count,
				"lastTerminationReason": clip(str(m, "lastState", "terminated", "reason"), 64),
				"init":                  key == "initContainerStatuses",
			}
			if len(containers) < 64 {
				containers = append(containers, entry)
			}
			if key == "containerStatuses" {
				restarts += count
				if isReady {
					ready++
				}
			}
		}
	}
	status := map[string]any{
		"phase": str(obj.Object, "status", "phase"), "containerStatuses": containers,
		"readyCount": int64(ready), "restartCount": restarts,
		"containerCount": int64(countContainers(obj)),
	}
	if reason := str(obj.Object, "status", "reason"); reason != "" {
		status["reason"] = clip(reason, 64)
	}
	if ts := str(obj.Object, "status", "startTime"); ts != "" {
		status["startTimestamp"] = ts
	}
	out["status"] = status
	return &unstructured.Unstructured{Object: out}
}

func countContainers(obj *unstructured.Unstructured) int {
	list, _, _ := unstructured.NestedSlice(obj.Object, "spec", "containers")
	return len(list)
}

func containerState(c map[string]any) (state, reason string) {
	for _, s := range []string{"running", "waiting", "terminated"} {
		if m, ok, _ := unstructured.NestedMap(c, "state", s); ok {
			return s, str(m, "reason")
		}
	}
	return "unknown", ""
}

// projectEvent keeps warnings and anything about a Velero object, from the last hour.
func projectEvent(obj *unstructured.Unstructured) *unstructured.Unstructured {
	typ := str(obj.Object, "type")
	involved := str(obj.Object, "involvedObject", "apiVersion")
	if typ != "Warning" && !strings.HasPrefix(involved, "velero.io/") {
		return nil
	}
	last := str(obj.Object, "lastTimestamp")
	if last == "" {
		last = str(obj.Object, "eventTime")
	}
	if last == "" {
		last = obj.GetCreationTimestamp().UTC().Format(time.RFC3339)
	}
	if t, err := time.Parse(time.RFC3339, last); err != nil || now().Sub(t) > EventWindow {
		return nil
	}
	out := base(obj, "Event", false)
	count, _, _ := unstructured.NestedInt64(obj.Object, "count")
	out["status"] = map[string]any{
		"phase":          clip(typ, 16),
		"reason":         clip(str(obj.Object, "reason"), 64),
		"message":        clip(str(obj.Object, "message"), maxMessage),
		"count":          count,
		"startTimestamp": last,
		"involvedObject": map[string]any{
			"kind": clip(str(obj.Object, "involvedObject", "kind"), 63), "name": clip(str(obj.Object, "involvedObject", "name"), maxText),
			"namespace": clip(str(obj.Object, "involvedObject", "namespace"), 63), "apiVersion": clip(involved, 63),
		},
	}
	return &unstructured.Unstructured{Object: out}
}
