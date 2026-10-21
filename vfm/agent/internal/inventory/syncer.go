package inventory

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// Limits from PLAN.md §5.3 and §5.6.
const (
	DefaultChunkBytes  = 1 << 20
	DefaultBatchMax    = 500
	DefaultBatchWait   = 2 * time.Second
	DefaultMaxPending  = 5000
	DefaultResyncEvery = 10 * time.Minute
	// DefaultPodScopeThreshold is PLAN.md §7.1's 20 000 pods.
	DefaultPodScopeThreshold = 20000
)

// Options configures a [Syncer].
type Options struct {
	Dynamic   dynamic.Interface
	Discovery discovery.DiscoveryInterface
	// Namespace is where Velero runs; only objects there are synced.
	Namespace string
	// Kinds defaults to [VeleroKinds], plus [CoreKinds] when Core is set.
	Kinds []Kind
	// Core adds the live view of PLAN.md §7.1: nodes, namespaces, pods, PVCs, events.
	Core bool
	// PodScopeThreshold: above this many pods the agent reports pods only for the
	// namespaces the control plane asks about (PLAN.md §7.1). Default 20 000.
	PodScopeThreshold int

	// SendWait delivers a message, waiting for room. Snapshot chunks use it: a
	// snapshot is only useful whole, so it must not drop a chunk.
	SendWait func(context.Context, *pb.AgentMessage) error
	// TrySend delivers without waiting and reports whether it was accepted. Deltas
	// use it: when it refuses, the answer is a fresh snapshot, never a gap.
	TrySend func(*pb.AgentMessage) bool

	Logger *slog.Logger
	NewID  func() string

	ResyncEvery time.Duration
	ChunkBytes  int
	BatchMax    int
	BatchWait   time.Duration
	MaxPending  int
}

// Syncer reports a cluster's Velero objects to the control plane.
//
// The control plane replaces its copy of the cluster atomically when it has
// received every chunk of a snapshot, and applies deltas on top of the snapshot
// they name. So the agent's one invariant is: **a delta is sent only while a
// completed snapshot exists, and any doubt (a refused send, an overflow, a new
// connection, a server request) is answered with a new snapshot rather than a
// patch.** That is what makes missed events self-healing.
//
// While the stream is down nothing is buffered: the informer caches already hold
// the truth, and a snapshot on reconnect covers everything that happened. That is
// stronger than the 5 000-event buffer of PLAN.md §5.6 and cannot overflow.
type Syncer struct {
	opts    Options
	factory dynamicinformer.DynamicSharedInformerFactory
	// cluster is the same for the kinds watched in every namespace.
	cluster dynamicinformer.DynamicSharedInformerFactory

	resyncReq chan struct{}
	wake      chan struct{}

	mu         sync.Mutex
	informers  map[string]cache.SharedIndexInformer
	connected  bool
	snapshotID string
	batchSeq   uint64
	pending    []*pb.ResourceEvent
	// inSnapshot maps an object to the resource version the last snapshot carried,
	// so an informer event for exactly that version (the late echo of the initial
	// list) is not sent a second time.
	inSnapshot map[string]string
	// reported holds the keys of objects the control plane has been told about, so an
	// object that stops qualifying (an event past its hour, a pod outside the scope) is
	// deleted there exactly once instead of on every change.
	reported map[string]bool
	// scope is the namespaces whose pods are wanted; scoped means pods are limited to it.
	scope  map[string]bool
	scoped bool
}

// New returns a syncer; call [Syncer.Run] to start it.
func New(opts Options) *Syncer {
	if opts.Kinds == nil {
		opts.Kinds = VeleroKinds
		if opts.Core {
			opts.Kinds = append(append([]Kind{}, VeleroKinds...), CoreKinds...)
		}
	}
	if opts.PodScopeThreshold <= 0 {
		opts.PodScopeThreshold = DefaultPodScopeThreshold
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.ResyncEvery <= 0 {
		opts.ResyncEvery = DefaultResyncEvery
	}
	if opts.ChunkBytes <= 0 {
		opts.ChunkBytes = DefaultChunkBytes
	}
	if opts.BatchMax <= 0 {
		opts.BatchMax = DefaultBatchMax
	}
	if opts.BatchWait <= 0 {
		opts.BatchWait = DefaultBatchWait
	}
	if opts.MaxPending <= 0 {
		opts.MaxPending = DefaultMaxPending
	}
	return &Syncer{
		opts:      opts,
		factory:   dynamicinformer.NewFilteredDynamicSharedInformerFactory(opts.Dynamic, 0, opts.Namespace, nil),
		cluster:   dynamicinformer.NewFilteredDynamicSharedInformerFactory(opts.Dynamic, 0, metav1.NamespaceAll, nil),
		reported:  map[string]bool{},
		scope:     map[string]bool{},
		resyncReq: make(chan struct{}, 1),
		wake:      make(chan struct{}, 1),
		informers: map[string]cache.SharedIndexInformer{},
	}
}

// SetConnected tells the syncer whether the control plane has accepted the
// stream. Becoming connected starts a snapshot; either way anything pending is
// discarded, because a snapshot supersedes it.
func (s *Syncer) SetConnected(connected bool) {
	s.mu.Lock()
	s.connected = connected
	s.snapshotID = ""
	s.pending = nil
	s.mu.Unlock()
	if connected {
		s.Resync()
	}
}

// Resync asks for a new snapshot. It never blocks.
func (s *Syncer) Resync() {
	select {
	case s.resyncReq <- struct{}{}:
	default:
	}
}

// HandleServerMessage reacts to `RequestResync`.
func (s *Syncer) HandleServerMessage(msg *pb.ServerMessage) {
	if msg.GetResync() != nil {
		s.opts.Logger.Info("the control plane requested a resync", "reason", msg.GetResync().GetReason())
		s.Resync()
	}
	if ws := msg.GetWatchScope(); ws != nil {
		next := make(map[string]bool, len(ws.GetPodNamespaces()))
		for _, ns := range ws.GetPodNamespaces() {
			next[ns] = true
		}
		s.mu.Lock()
		changed := len(next) != len(s.scope)
		for ns := range next {
			changed = changed || !s.scope[ns]
		}
		s.scope = next
		scoped := s.scoped
		s.mu.Unlock()
		// A small cluster reports every pod whatever it is told; only a scoped one has
		// anything to change.
		if changed && scoped {
			s.opts.Logger.Info("the pod scope changed", "namespaces", len(next))
			s.Resync()
		}
	}
}

// Run watches until ctx ends.
func (s *Syncer) Run(ctx context.Context) {
	ticker := time.NewTicker(s.opts.ResyncEvery)
	defer ticker.Stop()

	var batch *time.Timer
	var batchC <-chan time.Time
	defer func() {
		if batch != nil {
			batch.Stop()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return

		case <-s.resyncReq:
			s.ensureInformers(ctx)
			s.snapshot(ctx)
			s.wakeBatcher()

		case <-ticker.C:
			if s.isConnected() {
				s.Resync()
			}

		case <-s.wake:
			// The first pending event starts the clock: nothing waits longer than
			// BatchWait, and a burst becomes one message (PLAN.md §5.3).
			if batch == nil && s.hasPending() {
				batch = time.NewTimer(s.opts.BatchWait)
				batchC = batch.C
			}
			if s.pendingCount() >= s.opts.BatchMax {
				s.flush()
			}

		case <-batchC:
			batch, batchC = nil, nil
			s.flush()
			if s.hasPending() {
				batch = time.NewTimer(s.opts.BatchWait)
				batchC = batch.C
			}
		}
	}
}

// ensureInformers starts a watch for every kind the cluster serves that is not
// already watched. It runs on every resync, so installing Velero (or upgrading it
// to a version with the data-mover kinds) after the agent started is picked up.
func (s *Syncer) ensureInformers(ctx context.Context) {
	kinds, err := Available(ctx, s.opts.Discovery, s.opts.Kinds)
	if err != nil {
		// Keep what is already watched; a discovery outage must not look like
		// "Velero has nothing".
		s.opts.Logger.Warn("could not detect which Velero kinds the cluster serves", "error", err)
		return
	}

	var started []cache.SharedIndexInformer
	s.mu.Lock()
	for _, kind := range kinds {
		key := kind.String()
		if _, ok := s.informers[key]; ok {
			continue
		}
		factory := s.factory
		if kind.Cluster {
			factory = s.cluster
		}
		informer := factory.ForResource(kind.GVR).Informer()
		if _, err := informer.AddEventHandler(s.handlerFor(kind)); err != nil {
			s.opts.Logger.Error("could not watch a Velero kind", "kind", key, "error", err)
			continue
		}
		s.informers[key] = informer
		started = append(started, informer)
		s.opts.Logger.Info("watching", "kind", key)
	}
	s.mu.Unlock()

	if len(started) == 0 {
		return
	}
	s.factory.Start(ctx.Done())
	s.cluster.Start(ctx.Done())
	syncs := make([]cache.InformerSynced, 0, len(started))
	for _, informer := range started {
		syncs = append(syncs, informer.HasSynced)
	}
	if !cache.WaitForCacheSync(ctx.Done(), syncs...) {
		s.opts.Logger.Warn("stopped before the informer caches synced")
	}
}

func (s *Syncer) handlerFor(kind Kind) cache.ResourceEventHandler {
	upsert := func(obj any) {
		if u, ok := obj.(*unstructured.Unstructured); ok {
			s.enqueue(kind, pb.ResourceEventType_RESOURCE_EVENT_TYPE_UPSERT, u)
		}
	}
	return cache.ResourceEventHandlerFuncs{
		AddFunc:    upsert,
		UpdateFunc: func(_, obj any) { upsert(obj) },
		DeleteFunc: func(obj any) {
			if tomb, ok := obj.(cache.DeletedFinalStateUnknown); ok {
				obj = tomb.Obj
			}
			if u, ok := obj.(*unstructured.Unstructured); ok {
				s.enqueue(kind, pb.ResourceEventType_RESOURCE_EVENT_TYPE_DELETE, u)
			}
		},
	}
}

func (s *Syncer) enqueue(kind Kind, typ pb.ResourceEventType, obj *unstructured.Unstructured) {
	var item *pb.ResourceItem
	if typ == pb.ResourceEventType_RESOURCE_EVENT_TYPE_DELETE {
		item = Tombstone(kind.Proto, obj)
	} else {
		var err error
		item, err = s.itemFor(kind, obj)
		switch {
		case errors.Is(err, errNotReported):
			// It does not qualify now: if the control plane holds it, retire it.
			typ = pb.ResourceEventType_RESOURCE_EVENT_TYPE_DELETE
			item = Tombstone(kind.Proto, obj)
		case err != nil:
			s.opts.Logger.Warn("skipping an object that cannot be synced", "kind", kind.String(), "error", err)
			return
		}
	}

	s.mu.Lock()
	if !s.connected {
		s.mu.Unlock()
		return
	}
	key := objectKey(item)
	if typ == pb.ResourceEventType_RESOURCE_EVENT_TYPE_DELETE && !s.reported[key] {
		s.mu.Unlock()
		return
	}
	if typ == pb.ResourceEventType_RESOURCE_EVENT_TYPE_UPSERT && s.inSnapshot[key] == item.GetResourceVersion() && item.GetResourceVersion() != "" {
		s.mu.Unlock()
		return
	}
	delete(s.inSnapshot, key)
	if len(s.pending) >= s.opts.MaxPending {
		// Too far behind to patch: drop the lot and send the truth instead.
		s.pending = nil
		s.snapshotID = ""
		s.mu.Unlock()
		s.opts.Logger.Warn("too many unsent changes; falling back to a full resync")
		s.Resync()
		return
	}
	if typ == pb.ResourceEventType_RESOURCE_EVENT_TYPE_DELETE {
		delete(s.reported, key)
	} else {
		s.reported[key] = true
	}
	s.pending = append(s.pending, &pb.ResourceEvent{Type: typ, Item: item})
	s.mu.Unlock()
	s.wakeBatcher()
}

// errNotReported means an object is not to be reported (now): the projection declined
// it, or it is a pod outside the scope of a large cluster.
var errNotReported = errors.New("not reported")

func (s *Syncer) itemFor(kind Kind, obj *unstructured.Unstructured) (*pb.ResourceItem, error) {
	if kind.Proto == pb.ResourceKind_RESOURCE_KIND_POD {
		s.mu.Lock()
		out := s.scoped && !s.scope[obj.GetNamespace()]
		s.mu.Unlock()
		if out {
			return nil, errNotReported
		}
	}
	if kind.Project != nil {
		projected := kind.Project(obj)
		if projected == nil {
			return nil, errNotReported
		}
		// The projection is a new object; what identifies the real one carries over.
		projected.SetResourceVersion(obj.GetResourceVersion())
		return Item(kind.Proto, projected)
	}
	return Item(kind.Proto, obj)
}

func (s *Syncer) wakeBatcher() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Syncer) isConnected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connected
}

func (s *Syncer) hasPending() bool { return s.pendingCount() > 0 }

func (s *Syncer) pendingCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}

// flush sends up to BatchMax pending events. Nothing is sent before a snapshot
// has completed: deltas are meaningless without the state they apply to.
func (s *Syncer) flush() {
	s.mu.Lock()
	if s.snapshotID == "" || len(s.pending) == 0 {
		s.mu.Unlock()
		return
	}
	n := min(len(s.pending), s.opts.BatchMax)
	events := s.pending[:n:n]
	s.pending = s.pending[n:]
	s.batchSeq++
	message := &pb.AgentMessage{
		MessageId: s.opts.NewID(),
		Payload: &pb.AgentMessage_Events{Events: &pb.ResourceEvents{
			SnapshotId:    s.snapshotID,
			BatchSequence: s.batchSeq,
			Events:        events,
		}},
	}
	s.mu.Unlock()

	if !s.opts.TrySend(message) {
		s.opts.Logger.Warn("the outbound queue refused a batch; falling back to a full resync")
		s.mu.Lock()
		s.pending = nil
		s.snapshotID = ""
		s.mu.Unlock()
		s.Resync()
	}
}

// snapshot sends the whole current state in chunks.
func (s *Syncer) snapshot(ctx context.Context) {
	if !s.isConnected() {
		return
	}
	s.mu.Lock()
	s.snapshotID = ""
	informers := make([]struct {
		kind Kind
		inf  cache.SharedIndexInformer
	}, 0, len(s.informers))
	for _, kind := range s.opts.Kinds {
		if inf, ok := s.informers[kind.String()]; ok {
			informers = append(informers, struct {
				kind Kind
				inf  cache.SharedIndexInformer
			}{kind, inf})
		}
	}
	s.mu.Unlock()

	// Pod scope: past the threshold only the asked-for namespaces are reported. The
	// switch back has some room (90 %) so a cluster hovering at the line does not flap.
	for _, e := range informers {
		if e.kind.Proto == pb.ResourceKind_RESOURCE_KIND_POD {
			pods := len(e.inf.GetStore().List())
			s.mu.Lock()
			if pods > s.opts.PodScopeThreshold {
				s.scoped = true
			} else if pods < s.opts.PodScopeThreshold*9/10 {
				s.scoped = false
			}
			s.mu.Unlock()
		}
	}

	var items []*pb.ResourceItem
	for _, e := range informers {
		for _, obj := range e.inf.GetStore().List() {
			u, ok := obj.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			item, err := s.itemFor(e.kind, u)
			if errors.Is(err, errNotReported) {
				continue
			}
			if err != nil {
				s.opts.Logger.Warn("skipping an object that cannot be synced", "kind", e.kind.String(), "error", err)
				continue
			}
			items = append(items, item)
		}
	}

	id := s.opts.NewID()
	taken := timestampNow()
	var chunk []*pb.ResourceItem
	size := 0
	var seq uint32
	send := func(last bool) bool {
		msg := &pb.AgentMessage{
			MessageId: s.opts.NewID(),
			Payload: &pb.AgentMessage_Snapshot{Snapshot: &pb.InventorySnapshot{
				SnapshotId: id, Sequence: seq, Last: last, Items: chunk, TakenAt: taken,
			}},
		}
		if err := s.opts.SendWait(ctx, msg); err != nil {
			return false
		}
		seq++
		chunk, size = nil, 0
		return true
	}

	for _, item := range items {
		cost := proto.Size(item)
		if len(chunk) > 0 && size+cost > s.opts.ChunkBytes {
			if !send(false) {
				return
			}
		}
		chunk = append(chunk, item)
		size += cost
	}
	if !send(true) {
		return
	}

	s.mu.Lock()
	// The stream may have dropped while the chunks were queued; then this
	// snapshot is already stale and the reconnect will start another.
	if s.connected {
		s.snapshotID = id
		s.batchSeq = 0
		s.inSnapshot = make(map[string]string, len(items))
		s.reported = make(map[string]bool, len(items))
		for _, it := range items {
			s.inSnapshot[objectKey(it)] = it.GetResourceVersion()
			s.reported[objectKey(it)] = true
		}
		// Events that arrived while the snapshot was being built and are already
		// in it are redundant.
		kept := s.pending[:0]
		for _, ev := range s.pending {
			if ev.GetType() == pb.ResourceEventType_RESOURCE_EVENT_TYPE_UPSERT &&
				s.inSnapshot[objectKey(ev.GetItem())] == ev.GetItem().GetResourceVersion() {
				continue
			}
			delete(s.inSnapshot, objectKey(ev.GetItem()))
			if ev.GetType() == pb.ResourceEventType_RESOURCE_EVENT_TYPE_UPSERT {
				s.reported[objectKey(ev.GetItem())] = true
			}
			kept = append(kept, ev)
		}
		s.pending = kept
	}
	s.mu.Unlock()
	s.opts.Logger.Info("inventory snapshot sent", "snapshot_id", id, "items", len(items), "chunks", seq)
}

func objectKey(it *pb.ResourceItem) string {
	return it.GetKind().String() + "/" + it.GetNamespace() + "/" + it.GetName() + "/" + it.GetUid()
}
