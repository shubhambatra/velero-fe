package loadtest

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/gateway"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/identity"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

const (
	chunkBytes = 1 << 20 // PLAN §5.3: a snapshot chunk is at most 1 MB
	batchMax   = 500     // and a batch of changes at most 500 events
	batchWait  = 2 * time.Second
)

// Agent is one simulated cluster. Its connection is the production [gateway.Manager]
// (enrolment, mTLS, Hello, heartbeats, backoff); what the load test supplies is what a
// real agent reads from Kubernetes and Velero.
type Agent struct {
	idx int
	cl  FixtureCluster
	cfg Config
	hub *Hub
	inv *Inventory
	mgr *gateway.Manager

	mu          sync.Mutex
	connected   bool
	snapshotID  string
	batchSeq    uint64
	pending     []*pb.ResourceEvent
	building    bool
	scoped      bool
	scope       map[string]bool
	cancelSnap  context.CancelFunc
	ctx         context.Context
	conns       map[net.Conn]struct{}
	connectedAt time.Time
	connects    int

	// Observations the report needs.
	firstConnected atomic.Int64 // unix nano
	lastConnected  atomic.Int64
	lastSnapStart  atomic.Int64
	lastSnapDone   atomic.Int64
	commands       atomic.Int64
}

// NewAgent builds the agent of one fixture cluster.
func NewAgent(idx int, fx *Fixture, cfg Config, hub *Hub, now time.Time) (*Agent, error) {
	pods := cfg.Pods
	if idx == 0 && cfg.BigPods > 0 {
		pods = cfg.BigPods
	}
	cl := fx.Clusters[idx]
	a := &Agent{
		idx: idx, cl: cl, cfg: cfg, hub: hub, scope: map[string]bool{}, conns: map[net.Conn]struct{}{},
		inv: NewInventory(GenConfig{Seed: uint64(cfg.Seed), Index: idx, VeleroObjs: cfg.VeleroObjs, Pods: pods, Nodes: cfg.Nodes, Namespaces: cfg.Namespaces}, now), //nolint:gosec // a seed
	}
	mgr, err := gateway.New(gateway.Options{
		Address:         fx.Gateway,
		ServerName:      fx.GatewayServerName,
		BootstrapCA:     []byte(fx.CAPEM),
		EnrollmentToken: cl.BootstrapToken,
		Store:           &identity.MemoryStore{},
		Fingerprint: func(context.Context) (string, error) {
			// Stable per cluster, like the UID of a real kube-system namespace.
			return fmt.Sprintf("0194f9d2-0000-7000-8000-%012x", idx+1), nil
		},
		Hello:             a.hello,
		AgentVersion:      "loadtest",
		HeartbeatInterval: 15 * time.Second,
		OnMessage:         a.onMessage,
		OnConnection:      a.onConnection,
		Logger:            slog.New(countingHandler{hub: hub}),
		DialOptions:       []grpc.DialOption{grpc.WithContextDialer(a.dial)},
	})
	if err != nil {
		return nil, err
	}
	a.mgr = mgr
	return a, nil
}

// ClusterID is the control plane's id of this cluster.
func (a *Agent) ClusterID() string { return a.cl.ID }

// Connected reports whether the control plane has accepted the stream.
func (a *Agent) Connected() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.connected
}

func (a *Agent) hello(context.Context) *pb.Hello {
	return &pb.Hello{
		ChartVersion: "0.1.0", ImageTag: "loadtest", KubernetesVersion: "v1.31.2",
		Capabilities: []string{"download"},
		Policy:       &pb.AgentPolicy{AllowRestore: true, AllowBslWrite: true, AllowLogStreaming: true},
	}
}

// dial opens a connection and remembers it, so a reconnect storm can cut them all at once.
func (a *Agent) dial(ctx context.Context, addr string) (net.Conn, error) {
	c, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	t := &trackedConn{Conn: c, agent: a}
	a.mu.Lock()
	a.conns[t] = struct{}{}
	a.mu.Unlock()
	return t, nil
}

type trackedConn struct {
	net.Conn
	agent *Agent
}

func (t *trackedConn) Close() error {
	t.agent.mu.Lock()
	delete(t.agent.conns, t)
	t.agent.mu.Unlock()
	return t.Conn.Close()
}

// DropConnections closes every open connection at once, as a network failure or a
// restarted gateway would.
func (a *Agent) DropConnections() {
	a.mu.Lock()
	open := make([]net.Conn, 0, len(a.conns))
	for c := range a.conns {
		open = append(open, c)
	}
	a.mu.Unlock()
	for _, c := range open {
		_ = c.Close()
	}
}

// Run keeps the agent alive until ctx ends, starting after `delay` (the ramp).
func (a *Agent) Run(ctx context.Context, delay time.Duration) {
	a.mu.Lock()
	a.ctx = ctx
	a.mu.Unlock()
	select {
	case <-ctx.Done():
		return
	case <-time.After(delay):
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = a.mgr.Run(ctx) }()
	go func() { defer wg.Done(); a.changes(ctx) }()
	wg.Wait()
}

func (a *Agent) onConnection(up bool) {
	now := time.Now()
	a.mu.Lock()
	a.connected = up
	if up {
		a.connects++
		a.connectedAt = now
	} else {
		a.snapshotID, a.pending = "", nil
		if a.cancelSnap != nil {
			a.cancelSnap()
		}
	}
	a.mu.Unlock()
	if up {
		a.firstConnected.CompareAndSwap(0, now.UnixNano())
		a.lastConnected.Store(now.UnixNano())
		a.hub.Connected(1)
		a.resync()
	} else {
		a.hub.Connected(-1)
	}
}

func (a *Agent) onMessage(m *pb.ServerMessage) {
	switch {
	case m.GetCommand() != nil:
		a.hub.CommandSeen(m.GetCommand().GetCommandId(), time.Now())
		go a.execute(m.GetCommand())
	case m.GetResync() != nil:
		a.resync()
	case m.GetWatchScope() != nil:
		next := map[string]bool{}
		for _, ns := range m.GetWatchScope().GetPodNamespaces() {
			next[ns] = true
		}
		a.mu.Lock()
		changed := len(next) != len(a.scope)
		for ns := range next {
			changed = changed || !a.scope[ns]
		}
		a.scope = next
		scoped := a.scoped
		a.mu.Unlock()
		if changed && scoped {
			a.resync()
		}
	case m.GetStartLogs() != nil:
		// The load test does not stream logs; end the session so the server does not wait.
		_ = a.mgr.Send(&pb.AgentMessage{Payload: &pb.AgentMessage_LogEnded{LogEnded: &pb.LogSessionEnded{
			SessionId: m.GetStartLogs().GetSessionId(), Reason: pb.LogSessionEndReason_LOG_SESSION_END_REASON_STOPPED}}})
	}
}

// execute acknowledges a command at once and finishes it after a short think.
func (a *Agent) execute(c *pb.Command) {
	a.commands.Add(1)
	_ = a.mgr.Send(&pb.AgentMessage{Payload: &pb.AgentMessage_Ack{Ack: &pb.CommandAck{
		CommandId: c.GetCommandId(), State: pb.CommandAckState_COMMAND_ACK_STATE_ACKED}}})
	time.Sleep(time.Duration(20+rand.IntN(180)) * time.Millisecond) //nolint:gosec // jitter
	res := &pb.CommandResult{CommandId: c.GetCommandId(), Ok: true, FinishedAt: timestamppb.Now()}
	if c.GetRefreshStatus() != nil {
		res.Detail = &pb.CommandResult_ServerStatus{ServerStatus: &pb.ServerStatus{
			ServerVersion: "v1.18.4", ProcessedAt: timestamppb.Now(),
			Plugins: []*pb.PluginInfo{{Name: "velero.io/aws", Kind: "ObjectStore"}},
		}}
	}
	a.mu.Lock()
	ctx := a.ctx
	a.mu.Unlock()
	if ctx == nil {
		return
	}
	if err := a.mgr.SendWait(ctx, &pb.AgentMessage{Payload: &pb.AgentMessage_Result{Result: res}}); err != nil {
		return
	}
}

// resync starts a new snapshot, replacing one in progress.
func (a *Agent) resync() {
	a.mu.Lock()
	if a.cancelSnap != nil {
		a.cancelSnap()
	}
	parent := a.ctx
	if parent == nil || !a.connected {
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	a.cancelSnap = cancel
	a.snapshotID, a.pending, a.building = "", nil, true
	a.mu.Unlock()
	go a.snapshot(ctx)
}

func (a *Agent) inScope(ns string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.scope[ns]
}

// snapshot sends the whole state in chunks of at most 1 MB, as the real agent does.
func (a *Agent) snapshot(ctx context.Context) {
	started := time.Now()
	a.lastSnapStart.Store(started.UnixNano())
	// Past the threshold only asked-for namespaces are reported (PLAN §7.1), with 10 % hysteresis.
	pods := a.inv.PodCount()
	a.mu.Lock()
	if pods > a.cfg.PodThreshold {
		a.scoped = true
	} else if pods < a.cfg.PodThreshold*9/10 {
		a.scoped = false
	}
	scoped := a.scoped
	a.mu.Unlock()

	items := a.inv.Items(started, scoped, a.inScope)
	id := gateway.NewMessageID()
	taken := timestamppb.New(started)
	var chunk []*pb.ResourceItem
	size, seq := 0, uint32(0)
	send := func(last bool) bool {
		msg := &pb.AgentMessage{Payload: &pb.AgentMessage_Snapshot{Snapshot: &pb.InventorySnapshot{
			SnapshotId: id, Sequence: seq, Last: last, Items: chunk, TakenAt: taken}}}
		if err := a.mgr.SendWait(ctx, msg); err != nil {
			return false
		}
		seq++
		chunk, size = nil, 0
		return true
	}
	for _, it := range items {
		cost := proto.Size(it)
		if len(chunk) > 0 && size+cost > chunkBytes {
			if !send(false) {
				return
			}
		}
		chunk = append(chunk, it)
		size += cost
	}
	if !send(true) {
		return
	}
	a.mu.Lock()
	if a.connected && ctx.Err() == nil {
		a.snapshotID, a.batchSeq, a.pending, a.building = id, 0, nil, false
	}
	a.mu.Unlock()
	a.lastSnapDone.Store(time.Now().UnixNano())
	a.hub.Reg.Get("agent snapshot send").Add(time.Now(), time.Since(started))
}

// changes makes the steady trickle of changes a live cluster has and reports them in
// batches no more than two seconds apart.
func (a *Agent) changes(ctx context.Context) {
	rng := rand.New(rand.NewPCG(uint64(a.cfg.Seed), uint64(a.idx)+9999)) //nolint:gosec // jitter
	flush := time.NewTicker(batchWait)
	defer flush.Stop()
	next := time.Now().Add(a.gap(rng))
	for {
		wait := time.Until(next)
		if wait < 0 {
			wait = 0
		}
		select {
		case <-ctx.Done():
			return
		case <-flush.C:
			a.flush()
		case <-time.After(wait):
			a.mutate()
			next = time.Now().Add(a.gap(rng))
		}
	}
}

// gap is an exponentially distributed wait with the configured mean rate.
func (a *Agent) gap(rng *rand.Rand) time.Duration {
	if a.cfg.EventsPerSec <= 0 {
		return time.Hour
	}
	return time.Duration(rng.ExpFloat64() / a.cfg.EventsPerSec * float64(time.Second))
}

func (a *Agent) mutate() {
	a.mu.Lock()
	ready := a.connected && a.snapshotID != "" && !a.building
	scoped := a.scoped
	a.mu.Unlock()
	if !ready {
		return
	}
	events := a.inv.Mutate(time.Now(), scoped, a.inScope)
	a.mu.Lock()
	if a.snapshotID != "" {
		a.pending = append(a.pending, events...)
	}
	a.mu.Unlock()
}

func (a *Agent) flush() {
	a.mu.Lock()
	if a.snapshotID == "" || len(a.pending) == 0 {
		a.mu.Unlock()
		return
	}
	n := min(len(a.pending), batchMax)
	events := a.pending[:n:n]
	a.pending = a.pending[n:]
	a.batchSeq++
	msg := &pb.AgentMessage{Payload: &pb.AgentMessage_Events{Events: &pb.ResourceEvents{
		SnapshotId: a.snapshotID, BatchSequence: a.batchSeq, Events: events}}}
	a.mu.Unlock()
	now := time.Now()
	if !a.mgr.Send(msg) {
		// The queue is full: a real agent answers with a fresh snapshot, never a gap.
		a.hub.Reg.Get("agent queue refused a batch").Fail(0)
		a.resync()
		return
	}
	a.hub.Events.Emitted(a.cl.ID, now)
}

// LastConnected is when the agent last (re)connected, zero if it never has.
func (a *Agent) LastConnected() time.Time { return unixNano(a.lastConnected.Load()) }

// Commands is how many commands the agent has executed.
func (a *Agent) Commands() int64 { return a.commands.Load() }

func unixNano(n int64) time.Time {
	if n == 0 {
		return time.Time{}
	}
	return time.Unix(0, n)
}
