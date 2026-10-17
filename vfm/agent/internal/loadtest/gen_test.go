package loadtest

import (
	"encoding/json"
	"testing"
	"time"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

var t0 = time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)

func cfg(idx int) GenConfig {
	return GenConfig{Seed: 7, Index: idx, VeleroObjs: 250, Pods: 300, Nodes: 20, Namespaces: 60}
}

func TestVeleroCountsFollowTheRealMixAndAddUp(t *testing.T) {
	for _, n := range []int{1, 10, 100, 250, 1000} {
		total := 0
		for _, v := range VeleroCounts(n) {
			total += v
		}
		if total != n {
			t.Errorf("n=%d: kinds add up to %d", n, total)
		}
	}
	c := VeleroCounts(250)
	if c[pb.ResourceKind_RESOURCE_KIND_BACKUP] < 140 || c[pb.ResourceKind_RESOURCE_KIND_BACKUP] > 160 {
		t.Errorf("backups: %d", c[pb.ResourceKind_RESOURCE_KIND_BACKUP])
	}
	if c[pb.ResourceKind_RESOURCE_KIND_POD_VOLUME_BACKUP] != 37 || c[pb.ResourceKind_RESOURCE_KIND_BACKUP_STORAGE_LOCATION] != 2 {
		t.Errorf("%v", c)
	}
	if len(VeleroCounts(0)) != 0 {
		t.Error("zero objects means none")
	}
}

func TestEveryGeneratedItemIsWhatTheServerAccepts(t *testing.T) {
	inv := NewInventory(cfg(1), t0)
	items := inv.Items(t0, false, nil)
	// 250 Velero + 60 namespaces + 20 nodes + 300 pods + 60 claims + 8 warnings.
	if len(items) != 250+60+20+300+60+8 {
		t.Fatalf("%d items", len(items))
	}
	kinds := map[pb.ResourceKind]int{}
	seen := map[string]bool{}
	for _, it := range items {
		kinds[it.GetKind()]++
		key := it.GetKind().String() + "/" + it.GetNamespace() + "/" + it.GetName()
		if seen[key] {
			t.Fatalf("duplicate %s", key)
		}
		seen[key] = true
		var obj map[string]any
		if err := json.Unmarshal(it.GetObjectJson(), &obj); err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		meta, _ := obj["metadata"].(map[string]any)
		if meta["name"] != it.GetName() || meta["uid"] != it.GetUid() {
			t.Fatalf("%s: identity does not match the object: %v", key, meta)
		}
		if ns, _ := meta["namespace"].(string); ns != it.GetNamespace() {
			t.Fatalf("%s: namespace %q vs %q", key, ns, it.GetNamespace())
		}
		clusterScoped := it.GetKind() == pb.ResourceKind_RESOURCE_KIND_NODE || it.GetKind() == pb.ResourceKind_RESOURCE_KIND_NAMESPACE
		if clusterScoped != (it.GetNamespace() == "") {
			t.Fatalf("%s: scope wrong", key)
		}
		if len(it.GetUid()) == 0 || len(it.GetUid()) > 64 || len(it.GetObjectJson()) > 256*1024 {
			t.Fatalf("%s: uid or size", key)
		}
		if isVelero(it.GetKind()) {
			if n := len(it.GetObjectJson()); n < 2000 || n > 4300 {
				t.Errorf("%s: %d bytes, want 2–4 KB", key, n)
			}
			if obj["apiVersion"] != "velero.io/v1" {
				t.Errorf("%s: apiVersion %v", key, obj["apiVersion"])
			}
		}
	}
	if kinds[pb.ResourceKind_RESOURCE_KIND_NODE] != 20 || kinds[pb.ResourceKind_RESOURCE_KIND_NAMESPACE] != 60 || kinds[pb.ResourceKind_RESOURCE_KIND_POD] != 300 {
		t.Errorf("%v", kinds)
	}
}

func TestTheSameSeedMakesTheSameClusterAndAnotherMakesAnother(t *testing.T) {
	a, b := NewInventory(cfg(1), t0).Items(t0, false, nil), NewInventory(cfg(1), t0).Items(t0, false, nil)
	c := NewInventory(cfg(2), t0).Items(t0, false, nil)
	if len(a) != len(b) {
		t.Fatal("not deterministic")
	}
	for i := range a {
		if a[i].GetName() != b[i].GetName() || string(a[i].GetObjectJson()) != string(b[i].GetObjectJson()) {
			t.Fatalf("item %d differs between runs", i)
		}
	}
	if a[len(a)-1].GetName() == c[len(c)-1].GetName() && a[len(a)-1].GetUid() == c[len(c)-1].GetUid() {
		t.Error("two clusters look identical")
	}
}

func TestAScopedClusterReportsPodsOnlyWhereAsked(t *testing.T) {
	inv := NewInventory(cfg(1), t0)
	all := inv.Items(t0, false, nil)
	scoped := inv.Items(t0, true, func(ns string) bool { return ns == "ns-001" })
	pods := func(items []*pb.ResourceItem) (n int) {
		for _, it := range items {
			if it.GetKind() == pb.ResourceKind_RESOURCE_KIND_POD {
				n++
				if len(items) != len(all) && it.GetNamespace() != "ns-001" {
					t.Fatalf("pod of %s reported out of scope", it.GetNamespace())
				}
			}
		}
		return n
	}
	if pods(all) != 300 || pods(scoped) >= 300 {
		t.Fatalf("%d / %d", pods(all), pods(scoped))
	}
	// Everything but pods is still there.
	if len(all)-pods(all) != len(scoped)-pods(scoped) {
		t.Error("scoping dropped something that is not a pod")
	}
}

func TestMutationsAreWellFormedAndKeepTheClusterConsistent(t *testing.T) {
	inv := NewInventory(cfg(3), t0)
	before := inv.ObjectCount()
	var upserts, deletes int
	for i := 0; i < 600; i++ {
		for _, ev := range inv.Mutate(t0.Add(time.Duration(i)*time.Second), false, nil) {
			it := ev.GetItem()
			if it.GetName() == "" || it.GetUid() == "" || it.GetKind() == pb.ResourceKind_RESOURCE_KIND_UNSPECIFIED {
				t.Fatalf("malformed event %v", ev)
			}
			switch ev.GetType() {
			case pb.ResourceEventType_RESOURCE_EVENT_TYPE_UPSERT:
				upserts++
				if !json.Valid(it.GetObjectJson()) || it.GetResourceVersion() == "" {
					t.Fatalf("bad upsert %s", it.GetName())
				}
			case pb.ResourceEventType_RESOURCE_EVENT_TYPE_DELETE:
				deletes++
				if len(it.GetObjectJson()) != 0 {
					t.Fatal("a delete carries only identity")
				}
			default:
				t.Fatalf("type %v", ev.GetType())
			}
		}
	}
	if upserts == 0 || deletes == 0 {
		t.Fatalf("a long run changes things: %d upserts, %d deletes", upserts, deletes)
	}
	if inv.PodCount() != 300 {
		t.Errorf("pods are replaced, not lost: %d", inv.PodCount())
	}
	if inv.ObjectCount() <= before {
		t.Error("backups and warnings accumulate")
	}
	// The snapshot after the churn is still consistent: unique keys, valid JSON.
	seen := map[string]bool{}
	for _, it := range inv.Items(t0, false, nil) {
		k := it.GetKind().String() + it.GetNamespace() + it.GetName()
		if seen[k] || !json.Valid(it.GetObjectJson()) {
			t.Fatalf("inconsistent after churn: %s", k)
		}
		seen[k] = true
	}
}

func TestMutationsStayInsideThePodScope(t *testing.T) {
	inv := NewInventory(cfg(4), t0)
	in := func(ns string) bool { return ns == "ns-002" }
	for i := 0; i < 400; i++ {
		for _, ev := range inv.Mutate(t0, true, in) {
			it := ev.GetItem()
			if it.GetKind() == pb.ResourceKind_RESOURCE_KIND_POD && it.GetNamespace() != "ns-002" {
				t.Fatalf("a pod outside the scope changed: %s", it.GetNamespace())
			}
		}
	}
}
