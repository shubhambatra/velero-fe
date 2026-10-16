package inventory

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/discovery"
	fakediscovery "k8s.io/client-go/discovery/fake"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// sink records what the syncer sends.
type sink struct {
	mu     sync.Mutex
	msgs   []*pb.AgentMessage
	refuse atomic.Bool
	// gate, when set, makes sendWait block until it is closed: a snapshot that is
	// still being delivered.
	gate atomic.Pointer[chan struct{}]
	ids  atomic.Int64
}

func (s *sink) trySend(m *pb.AgentMessage) bool {
	if s.refuse.Load() {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.msgs = append(s.msgs, m)
	return true
}

func (s *sink) sendWait(ctx context.Context, m *pb.AgentMessage) error {
	if g := s.gate.Load(); g != nil {
		select {
		case <-*g:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.msgs = append(s.msgs, m)
	return nil
}

func (s *sink) newID() string { return fmt.Sprintf("id-%d", s.ids.Add(1)) }

func (s *sink) all() []*pb.AgentMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*pb.AgentMessage(nil), s.msgs...)
}

// snapshots groups snapshot chunks by snapshot id, in arrival order.
func (s *sink) snapshots() (order []string, byID map[string][]*pb.InventorySnapshot) {
	byID = map[string][]*pb.InventorySnapshot{}
	for _, m := range s.all() {
		if sn := m.GetSnapshot(); sn != nil {
			if _, ok := byID[sn.GetSnapshotId()]; !ok {
				order = append(order, sn.GetSnapshotId())
			}
			byID[sn.GetSnapshotId()] = append(byID[sn.GetSnapshotId()], sn)
		}
	}
	return order, byID
}

func (s *sink) batches() []*pb.ResourceEvents {
	var out []*pb.ResourceEvents
	for _, m := range s.all() {
		if e := m.GetEvents(); e != nil {
			out = append(out, e)
		}
	}
	return out
}

var allGVRs = func() map[schema.GroupVersionResource]string {
	out := map[schema.GroupVersionResource]string{}
	for _, k := range VeleroKinds {
		out[k.GVR] = "List"
	}
	return out
}()

func object(gvr schema.GroupVersionResource, kind, name string, extra map[string]any) *unstructured.Unstructured {
	meta := map[string]any{"name": name, "namespace": "velero", "uid": "uid-" + name, "resourceVersion": "1"}
	for k, v := range extra {
		meta[k] = v
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": gvr.GroupVersion().String(), "kind": kind, "metadata": meta, "spec": map[string]any{},
	}}
}

func backup(name string) *unstructured.Unstructured {
	return object(VeleroKinds[0].GVR, "Backup", name, nil)
}

type cluster struct {
	dyn  *dynamicfake.FakeDynamicClient
	disc *fakediscovery.FakeDiscovery
}

func newCluster(served ...schema.GroupVersion) *cluster {
	disc := &fakediscovery.FakeDiscovery{Fake: &clienttesting.Fake{}}
	for _, gv := range served {
		list := &metav1.APIResourceList{GroupVersion: gv.String()}
		for _, k := range VeleroKinds {
			if k.GVR.GroupVersion() == gv {
				list.APIResources = append(list.APIResources, metav1.APIResource{Name: k.GVR.Resource, Namespaced: true})
			}
		}
		disc.Resources = append(disc.Resources, list)
	}
	return &cluster{dyn: dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), allGVRs), disc: disc}
}

func (c *cluster) create(t *testing.T, gvr schema.GroupVersionResource, obj *unstructured.Unstructured) {
	t.Helper()
	if _, err := c.dyn.Resource(gvr).Namespace("velero").Create(context.Background(), obj, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
}

func (c *cluster) deleteBackup(t *testing.T, name string) {
	t.Helper()
	if err := c.dyn.Resource(VeleroKinds[0].GVR).Namespace("velero").Delete(context.Background(), name, metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
}

func fastOptions(c *cluster, s *sink) Options {
	return Options{
		Dynamic: c.dyn, Discovery: discovery.DiscoveryInterface(c.disc), Namespace: "velero",
		SendWait: s.sendWait, TrySend: s.trySend, NewID: s.newID,
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		BatchWait: 40 * time.Millisecond, ResyncEvery: time.Hour,
	}
}

func start(t *testing.T, opts Options) *Syncer {
	t.Helper()
	sy := New(opts)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { sy.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return sy
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func complete(s *sink, id string) bool {
	_, by := s.snapshots()
	chunks := by[id]
	return len(chunks) > 0 && chunks[len(chunks)-1].GetLast()
}

func itemNames(chunks []*pb.InventorySnapshot) []string {
	var out []string
	for _, c := range chunks {
		for _, it := range c.GetItems() {
			out = append(out, it.GetName())
		}
	}
	return out
}

func TestAvailableReturnsOnlyWhatTheClusterServes(t *testing.T) {
	c := newCluster(v1) // an older Velero: no v2alpha1 data-mover kinds
	got, err := Available(context.Background(), c.disc, VeleroKinds)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range got {
		if k.GVR.Version != "v1" {
			t.Errorf("%s is not served but was reported", k)
		}
	}
	if len(got) != 9 {
		t.Errorf("got %d kinds, want the 9 v1 kinds", len(got))
	}

	none, err := Available(context.Background(), newCluster().disc, VeleroKinds)
	if err != nil || len(none) != 0 {
		t.Errorf("a cluster without Velero: %v %v", none, err)
	}
}

func TestADiscoveryOutageIsAnErrorNotAnEmptyInventory(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	c.disc.PrependReactor("get", "resource", func(clienttesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewServiceUnavailable("api server restarting")
	})
	if _, err := Available(context.Background(), c.disc, VeleroKinds); err == nil {
		t.Fatal("an outage was reported as 'Velero serves nothing', which would empty the inventory")
	}
}

func TestItemStripsManagedFieldsAndLastAppliedAndKeepsTheRest(t *testing.T) {
	obj := object(VeleroKinds[0].GVR, "Backup", "b1", map[string]any{
		"labels":        map[string]any{"app": "shop"},
		"managedFields": []any{map[string]any{"manager": "kubectl"}},
		"annotations": map[string]any{
			lastApplied: `{"password":"pasted-by-mistake"}`, "keep": "me",
		},
		"creationTimestamp": "2026-10-16T05:00:00Z",
	})
	item, err := Item(pb.ResourceKind_RESOURCE_KIND_BACKUP, obj)
	if err != nil {
		t.Fatal(err)
	}
	raw := string(item.GetObjectJson())
	if strings.Contains(raw, "managedFields") || strings.Contains(raw, "pasted-by-mistake") || strings.Contains(raw, lastApplied) {
		t.Errorf("sensitive or noisy fields survived: %s", raw)
	}
	if !strings.Contains(raw, `"keep":"me"`) || !strings.Contains(raw, `"app":"shop"`) {
		t.Errorf("ordinary metadata was lost: %s", raw)
	}
	if item.GetName() != "b1" || item.GetNamespace() != "velero" || item.GetUid() != "uid-b1" || item.GetCreationTimestamp() == nil {
		t.Errorf("identity fields wrong: %+v", item)
	}
	if !json.Valid(item.GetObjectJson()) {
		t.Error("object_json is not JSON")
	}
	// The caller's object was not modified.
	if _, found, _ := unstructured.NestedSlice(obj.Object, "metadata", "managedFields"); !found {
		t.Error("Item mutated its input")
	}
}

func TestItemRefusesAnOversizedObjectInsteadOfTruncatingIt(t *testing.T) {
	obj := backup("huge")
	obj.Object["spec"] = map[string]any{"blob": strings.Repeat("x", MaxObjectBytes+1)}
	if _, err := Item(pb.ResourceKind_RESOURCE_KIND_BACKUP, obj); err == nil {
		t.Fatal("an object over the cap was accepted")
	}
}

func TestSnapshotOnConnectIsCompleteContiguousAndSanitised(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	c.create(t, VeleroKinds[0].GVR, backup("b1"))
	c.create(t, VeleroKinds[0].GVR, backup("b2"))
	c.create(t, VeleroKinds[2].GVR, object(VeleroKinds[2].GVR, "Schedule", "nightly", nil))
	s := &sink{}
	sy := start(t, fastOptions(c, s))

	sy.SetConnected(true)
	eventually(t, "a complete snapshot", func() bool {
		order, _ := s.snapshots()
		return len(order) == 1 && complete(s, order[0])
	})

	order, by := s.snapshots()
	chunks := by[order[0]]
	for i, ch := range chunks {
		if int(ch.GetSequence()) != i {
			t.Errorf("chunk %d has sequence %d", i, ch.GetSequence())
		}
		if ch.GetLast() != (i == len(chunks)-1) {
			t.Errorf("chunk %d has last=%v", i, ch.GetLast())
		}
		if ch.GetTakenAt() == nil {
			t.Error("no taken_at")
		}
	}
	got := itemNames(chunks)
	if len(got) != 3 {
		t.Fatalf("snapshot items = %v, want b1, b2, nightly", got)
	}
}

func TestAnEmptyClusterStillSendsACompleteSnapshot(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	s := &sink{}
	sy := start(t, fastOptions(c, s))
	sy.SetConnected(true)

	eventually(t, "the snapshot", func() bool {
		order, _ := s.snapshots()
		return len(order) == 1 && complete(s, order[0])
	})
	order, by := s.snapshots()
	if len(by[order[0]]) != 1 || len(by[order[0]][0].GetItems()) != 0 {
		t.Errorf("an empty cluster must be one empty last chunk so the server replaces its copy with nothing: %v", by[order[0]])
	}
}

func TestSnapshotsAreChunkedUnderTheLimitWithEveryItemExactlyOnce(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	const n = 60
	for i := range n {
		obj := backup(fmt.Sprintf("b%02d", i))
		obj.Object["spec"] = map[string]any{"note": strings.Repeat("y", 400)}
		c.create(t, VeleroKinds[0].GVR, obj)
	}
	s := &sink{}
	opts := fastOptions(c, s)
	opts.ChunkBytes = 4096
	sy := start(t, opts)
	sy.SetConnected(true)

	eventually(t, "the snapshot", func() bool {
		order, _ := s.snapshots()
		return len(order) == 1 && complete(s, order[0])
	})
	order, by := s.snapshots()
	chunks := by[order[0]]
	if len(chunks) < 5 {
		t.Fatalf("only %d chunks; the limit did not bite", len(chunks))
	}
	seen := map[string]int{}
	for _, ch := range chunks {
		size := 0
		for _, it := range ch.GetItems() {
			size += len(it.GetObjectJson())
			seen[it.GetName()]++
		}
		if len(ch.GetItems()) > 1 && size > 4096 {
			t.Errorf("a chunk of %d items carries %d bytes of objects, over the limit", len(ch.GetItems()), size)
		}
	}
	if len(seen) != n {
		t.Errorf("%d distinct items, want %d", len(seen), n)
	}
	for name, count := range seen {
		if count != 1 {
			t.Errorf("%s appeared %d times", name, count)
		}
	}
}

func TestChangesAfterTheSnapshotArriveAsDeltasThatNameIt(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	c.create(t, VeleroKinds[0].GVR, backup("b1"))
	s := &sink{}
	sy := start(t, fastOptions(c, s))
	sy.SetConnected(true)
	eventually(t, "the snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 1 && complete(s, o[0]) })
	snapshotID, _ := s.snapshots()

	c.create(t, VeleroKinds[0].GVR, backup("b2"))
	c.deleteBackup(t, "b1")

	eventually(t, "both deltas", func() bool {
		n := 0
		for _, b := range s.batches() {
			n += len(b.GetEvents())
		}
		return n >= 2
	})
	var upserted, deleted []string
	for _, b := range s.batches() {
		if b.GetSnapshotId() != snapshotID[0] {
			t.Errorf("a delta names snapshot %q, want %q", b.GetSnapshotId(), snapshotID[0])
		}
		for _, e := range b.GetEvents() {
			switch e.GetType() {
			case pb.ResourceEventType_RESOURCE_EVENT_TYPE_UPSERT:
				upserted = append(upserted, e.GetItem().GetName())
			case pb.ResourceEventType_RESOURCE_EVENT_TYPE_DELETE:
				deleted = append(deleted, e.GetItem().GetName())
				if len(e.GetItem().GetObjectJson()) != 0 {
					t.Error("a DELETE carries a body")
				}
			}
		}
	}
	if strings.Join(upserted, ",") != "b2" || strings.Join(deleted, ",") != "b1" {
		t.Errorf("upserted %v, deleted %v", upserted, deleted)
	}
}

func TestABurstBecomesOneBatchAndNothingWaitsLongerThanTheDebounce(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	s := &sink{}
	opts := fastOptions(c, s)
	opts.BatchWait = 150 * time.Millisecond
	sy := start(t, opts)
	sy.SetConnected(true)
	eventually(t, "the snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 1 && complete(s, o[0]) })

	for i := range 5 {
		c.create(t, VeleroKinds[0].GVR, backup(fmt.Sprintf("burst-%d", i)))
	}
	eventually(t, "the batch", func() bool { return len(s.batches()) >= 1 })
	time.Sleep(300 * time.Millisecond)

	batches := s.batches()
	total := 0
	for _, b := range batches {
		total += len(b.GetEvents())
	}
	if total != 5 || len(batches) != 1 {
		t.Errorf("%d events in %d batches; a burst inside the debounce window must be one message", total, len(batches))
	}
}

func TestBatchesNeverExceedTheMaximumAndSequenceIncreases(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	s := &sink{}
	opts := fastOptions(c, s)
	opts.BatchMax = 25
	sy := start(t, opts)
	sy.SetConnected(true)
	eventually(t, "the snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 1 && complete(s, o[0]) })

	const n = 130
	for i := range n {
		c.create(t, VeleroKinds[0].GVR, backup(fmt.Sprintf("m-%03d", i)))
	}
	eventually(t, "every event", func() bool {
		total := 0
		for _, b := range s.batches() {
			total += len(b.GetEvents())
		}
		return total >= n
	})
	var last uint64
	for _, b := range s.batches() {
		if len(b.GetEvents()) > 25 {
			t.Errorf("a batch of %d events exceeds the maximum", len(b.GetEvents()))
		}
		if b.GetBatchSequence() <= last {
			t.Errorf("batch sequence %d did not increase past %d", b.GetBatchSequence(), last)
		}
		last = b.GetBatchSequence()
	}
}

func TestNothingIsSentWhileDisconnectedAndReconnectingSnapshotsTheCurrentState(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	c.create(t, VeleroKinds[0].GVR, backup("before"))
	s := &sink{}
	sy := start(t, fastOptions(c, s))
	sy.SetConnected(true)
	eventually(t, "the first snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 1 && complete(s, o[0]) })

	sy.SetConnected(false)
	c.create(t, VeleroKinds[0].GVR, backup("while-away"))
	time.Sleep(200 * time.Millisecond)
	if n := len(s.batches()); n != 0 {
		t.Fatalf("%d batches sent while disconnected", n)
	}

	sy.SetConnected(true)
	eventually(t, "a second snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 2 && complete(s, o[1]) })
	order, by := s.snapshots()
	if order[0] == order[1] {
		t.Error("the new connection reused the old snapshot id")
	}
	got := itemNames(by[order[1]])
	if len(got) != 2 {
		t.Errorf("the reconnect snapshot has %v; it must include what changed while away", got)
	}
}

func TestARequestFromTheControlPlaneForcesANewSnapshot(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	s := &sink{}
	sy := start(t, fastOptions(c, s))
	sy.SetConnected(true)
	eventually(t, "the first snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 1 && complete(s, o[0]) })

	sy.HandleServerMessage(&pb.ServerMessage{Payload: &pb.ServerMessage_Resync{Resync: &pb.RequestResync{Reason: "test"}}})
	eventually(t, "a second snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 2 && complete(s, o[1]) })

	// Other server messages do not.
	sy.HandleServerMessage(&pb.ServerMessage{Payload: &pb.ServerMessage_Cancel{Cancel: &pb.CancelCommand{CommandId: "x"}}})
	time.Sleep(150 * time.Millisecond)
	if o, _ := s.snapshots(); len(o) != 2 {
		t.Errorf("an unrelated message caused a snapshot: %d", len(o))
	}
}

func TestThePeriodicResyncSendsAFreshSnapshotWhileConnected(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	s := &sink{}
	opts := fastOptions(c, s)
	opts.ResyncEvery = 120 * time.Millisecond
	sy := start(t, opts)
	sy.SetConnected(true)

	eventually(t, "three snapshots", func() bool { o, _ := s.snapshots(); return len(o) >= 3 })
}

func TestARefusedBatchFallsBackToASnapshotNeverAGap(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	s := &sink{}
	sy := start(t, fastOptions(c, s))
	sy.SetConnected(true)
	eventually(t, "the snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 1 && complete(s, o[0]) })

	s.refuse.Store(true) // the outbound queue is full
	c.create(t, VeleroKinds[0].GVR, backup("lost-delta"))
	time.Sleep(200 * time.Millisecond)
	s.refuse.Store(false)

	eventually(t, "a recovery snapshot that includes the change", func() bool {
		order, by := s.snapshots()
		if len(order) < 2 || !complete(s, order[len(order)-1]) {
			return false
		}
		return strings.Contains(strings.Join(itemNames(by[order[len(order)-1]]), ","), "lost-delta")
	})
}

func TestTooManyUnsentChangesFallBackToASnapshot(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	s := &sink{}
	opts := fastOptions(c, s)
	opts.MaxPending = 5
	opts.BatchWait = time.Hour // nothing flushes, so changes pile up
	opts.BatchMax = 1000
	sy := start(t, opts)
	sy.SetConnected(true)
	eventually(t, "the snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 1 && complete(s, o[0]) })

	for i := range 12 {
		c.create(t, VeleroKinds[0].GVR, backup(fmt.Sprintf("pile-%02d", i)))
	}
	eventually(t, "an overflow snapshot", func() bool { o, _ := s.snapshots(); return len(o) >= 2 })
}

func TestOnlyKindsTheClusterServesAreWatchedAndALaterInstallIsPickedUp(t *testing.T) {
	c := newCluster() // Velero is not installed yet
	s := &sink{}
	sy := start(t, fastOptions(c, s))
	sy.SetConnected(true)
	eventually(t, "an empty snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 1 && complete(s, o[0]) })
	if _, by := s.snapshots(); len(itemNames(by[firstKey(by)])) != 0 {
		t.Fatal("items from a Velero that is not there")
	}

	// Velero is installed, with a backup, and the control plane asks again.
	c.create(t, VeleroKinds[0].GVR, backup("first"))
	c.disc.Resources = append(c.disc.Resources, &metav1.APIResourceList{
		GroupVersion: v1.String(),
		APIResources: []metav1.APIResource{{Name: "backups", Namespaced: true}},
	})
	sy.Resync()

	eventually(t, "the new kind in a snapshot", func() bool {
		order, by := s.snapshots()
		return len(order) >= 2 && complete(s, order[len(order)-1]) &&
			strings.Contains(strings.Join(itemNames(by[order[len(order)-1]]), ","), "first")
	})
}

func firstKey(m map[string][]*pb.InventorySnapshot) string {
	for k := range m {
		return k
	}
	return ""
}

func TestUnservedKindsAreIgnoredEvenIfTheirObjectsExist(t *testing.T) {
	c := newCluster(v1) // v2alpha1 not served
	c.create(t, VeleroKinds[8].GVR, object(VeleroKinds[8].GVR, "DataUpload", "du1", nil))
	c.create(t, VeleroKinds[0].GVR, backup("b1"))
	s := &sink{}
	sy := start(t, fastOptions(c, s))
	sy.SetConnected(true)

	eventually(t, "the snapshot", func() bool { o, _ := s.snapshots(); return len(o) == 1 && complete(s, o[0]) })
	order, by := s.snapshots()
	if got := itemNames(by[order[0]]); len(got) != 1 || got[0] != "b1" {
		t.Errorf("items = %v; the unserved kind must not be reported", got)
	}
}

func TestADeletedObjectsTombstoneIdentifiesIt(t *testing.T) {
	obj := backup("gone")
	obj.SetUID(types.UID("u-1"))
	tomb := Tombstone(pb.ResourceKind_RESOURCE_KIND_BACKUP, obj)
	if tomb.GetName() != "gone" || tomb.GetUid() != "u-1" || tomb.GetNamespace() != "velero" || len(tomb.GetObjectJson()) != 0 {
		t.Errorf("tombstone = %+v", tomb)
	}
}

func TestNoDeltaIsSentWhileTheSnapshotIsStillBeingDelivered(t *testing.T) {
	c := newCluster(v1, v2alpha1)
	c.create(t, VeleroKinds[0].GVR, backup("existing"))
	s := &sink{}
	gate := make(chan struct{})
	s.gate.Store(&gate)
	sy := start(t, fastOptions(c, s))
	sy.SetConnected(true)

	// The snapshot is stuck mid-delivery; a change arrives and its debounce expires.
	time.Sleep(100 * time.Millisecond)
	c.create(t, VeleroKinds[0].GVR, backup("during"))
	time.Sleep(300 * time.Millisecond)
	if n := len(s.batches()); n != 0 {
		t.Fatalf("%d delta batch(es) were sent before any snapshot completed; the server cannot apply them", n)
	}

	close(gate)
	eventually(t, "the snapshot and then the delta", func() bool {
		order, by := s.snapshots()
		if len(order) != 1 || !complete(s, order[0]) {
			return false
		}
		// "during" is either already in the snapshot or follows it as a delta.
		inSnapshot := strings.Contains(strings.Join(itemNames(by[order[0]]), ","), "during")
		inDelta := false
		for _, b := range s.batches() {
			for _, e := range b.GetEvents() {
				inDelta = inDelta || e.GetItem().GetName() == "during"
			}
		}
		return inSnapshot || inDelta
	})
	for _, b := range s.batches() {
		order, _ := s.snapshots()
		if b.GetSnapshotId() != order[0] {
			t.Errorf("a delta names %q, not the completed snapshot %q", b.GetSnapshotId(), order[0])
		}
	}
}
