package logs

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

// pipeSource serves logs a test writes by hand.
type pipeSource struct {
	mu      sync.Mutex
	opened  []*corev1.PodLogOptions
	pipes   map[string]*io.PipeWriter
	openErr error
	exists  bool
}

func newSource() *pipeSource { return &pipeSource{pipes: map[string]*io.PipeWriter{}, exists: true} }

func (p *pipeSource) Open(_ context.Context, ns, pod string, opts *corev1.PodLogOptions) (io.ReadCloser, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.opened = append(p.opened, opts)
	if p.openErr != nil {
		return nil, p.openErr
	}
	r, w := io.Pipe()
	p.pipes[ns+"/"+pod] = w
	return r, nil
}

func (p *pipeSource) PodExists(context.Context, string, string) (bool, error) {
	return p.exists, nil
}

func (p *pipeSource) pipe(t *testing.T, key string) *io.PipeWriter {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		w := p.pipes[key]
		p.mu.Unlock()
		if w != nil {
			return w
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no log was opened for %s", key)
	return nil
}

type harness struct {
	s      *Streamer
	src    *pipeSource
	out    chan *pb.AgentMessage
	logbuf *bytes.Buffer
	pol    policy.Policy
}

func newHarness(t *testing.T, mutate func(*Options)) *harness {
	t.Helper()
	h := &harness{src: newSource(), out: make(chan *pb.AgentMessage, 256), logbuf: &bytes.Buffer{}, pol: policy.Default()}
	n := 0
	opts := Options{
		Source: h.src,
		Policy: func() policy.Policy { return h.pol },
		SendWait: func(ctx context.Context, m *pb.AgentMessage) error {
			select {
			case h.out <- m:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
		NewID:  func() string { n++; return "m" },
		Logger: slog.New(slog.NewJSONHandler(h.logbuf, nil)),
	}
	if mutate != nil {
		mutate(&opts)
	}
	h.s = New(opts)
	t.Cleanup(h.s.Disconnected)
	return h
}

func start(id, ns, pod string) *pb.ServerMessage {
	return &pb.ServerMessage{Payload: &pb.ServerMessage_StartLogs{StartLogs: &pb.StartLogSession{
		SessionId: id, Namespace: ns, Pod: pod, Container: "app", Follow: true,
	}}}
}

func stop(id string) *pb.ServerMessage {
	return &pb.ServerMessage{Payload: &pb.ServerMessage_StopLogs{StopLogs: &pb.StopLogSession{SessionId: id}}}
}

func (h *harness) next(t *testing.T) *pb.AgentMessage {
	t.Helper()
	select {
	case m := <-h.out:
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("nothing was sent")
		return nil
	}
}

func (h *harness) ended(t *testing.T) *pb.LogSessionEnded {
	t.Helper()
	for {
		m := h.next(t)
		if e := m.GetLogEnded(); e != nil {
			return e
		}
	}
}

func (h *harness) quiet(t *testing.T) {
	t.Helper()
	select {
	case m := <-h.out:
		t.Fatalf("expected nothing, got %v", m)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestStreamsChunksInOrderWithinTheLimit(t *testing.T) {
	h := newHarness(t, nil)
	h.s.HandleServerMessage(start("s1", "shop", "web-1"))
	w := h.src.pipe(t, "shop/web-1")

	go func() {
		_, _ = w.Write([]byte("hello\n"))
		_, _ = w.Write(bytes.Repeat([]byte("x"), 200*1024))
		_ = w.Close()
	}()

	var got []byte
	var seqs []uint64
	for {
		m := h.next(t)
		if c := m.GetLogChunk(); c != nil {
			if c.GetSessionId() != "s1" {
				t.Fatalf("chunk for %q", c.GetSessionId())
			}
			if len(c.GetData()) > MaxChunkBytes {
				t.Fatalf("a chunk of %d bytes exceeds the limit", len(c.GetData()))
			}
			got = append(got, c.GetData()...)
			seqs = append(seqs, c.GetSequence())
			continue
		}
		e := m.GetLogEnded()
		if e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_COMPLETED {
			t.Fatalf("reason %v", e.GetReason())
		}
		break
	}
	if len(got) != 6+200*1024 || !strings.HasPrefix(string(got), "hello\n") {
		t.Fatalf("got %d bytes", len(got))
	}
	for i, s := range seqs {
		if s != uint64(i) {
			t.Fatalf("sequence %v is not 0,1,2,...", seqs)
		}
	}
	if h.s.Active() != 0 {
		t.Fatal("the session was not forgotten")
	}
}

func TestPassesTheRequestedOptionsAndNeverFollowsAPreviousContainer(t *testing.T) {
	h := newHarness(t, nil)
	req := start("s1", "shop", "web-1")
	sl := req.GetStartLogs()
	sl.TailLines, sl.SinceSeconds, sl.Timestamps, sl.Previous = 50, 300, true, true
	h.s.HandleServerMessage(req)
	h.src.pipe(t, "shop/web-1")

	o := h.src.opened[0]
	if o.Container != "app" || *o.TailLines != 50 || *o.SinceSeconds != 300 || !o.Timestamps || !o.Previous {
		t.Fatalf("options %+v", o)
	}
	if o.Follow {
		t.Fatal("a previous container cannot be followed")
	}
}

func TestStopEndsTheSessionAndSaysSo(t *testing.T) {
	h := newHarness(t, nil)
	h.s.HandleServerMessage(start("s1", "shop", "web-1"))
	h.src.pipe(t, "shop/web-1")
	h.s.HandleServerMessage(stop("s1"))
	if e := h.ended(t); e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_STOPPED || e.GetSessionId() != "s1" {
		t.Fatalf("%v", e)
	}
	// Stopping a session that is gone is not an error and says nothing.
	h.s.HandleServerMessage(stop("s1"))
	h.quiet(t)
}

func TestPolicyRefusesBeforeAnythingIsRead(t *testing.T) {
	cases := map[string]policy.Policy{
		"streaming off":    {AllowLogStreaming: false},
		"namespace denied": {AllowLogStreaming: true, LogStreamDeniedNamespaces: []string{"shop"}},
		"all denied":       {AllowLogStreaming: true, LogStreamDeniedNamespaces: []string{"*"}},
	}
	for name, p := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, nil)
			h.pol = p
			h.s.HandleServerMessage(start("s1", "shop", "web-1"))
			e := h.ended(t)
			if e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_DENIED_BY_POLICY {
				t.Fatalf("reason %v", e.GetReason())
			}
			if len(h.src.opened) != 0 || h.s.Active() != 0 {
				t.Fatal("a refused session read the log or was kept")
			}
		})
	}
}

func TestRefusesNamesThatAreNotKubernetesNames(t *testing.T) {
	for _, tc := range []struct{ ns, pod, container string }{
		{"Shop", "web", "app"},
		{"shop", "../etc", "app"},
		{"shop", "web", "app/../x"},
		{"shop", "", "app"},
		{"shop", "web\n", "app"},
	} {
		h := newHarness(t, nil)
		m := start("s1", tc.ns, tc.pod)
		m.GetStartLogs().Container = tc.container
		h.s.HandleServerMessage(m)
		if e := h.ended(t); e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR {
			t.Fatalf("%+v: %v", tc, e)
		}
		if len(h.src.opened) != 0 {
			t.Fatalf("%+v reached the API server", tc)
		}
	}
	h := newHarness(t, nil)
	m := start("s1", "shop", "web")
	m.GetStartLogs().TailLines = maxTailLines + 1
	h.s.HandleServerMessage(m)
	if e := h.ended(t); e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR {
		t.Fatalf("%v", e)
	}
}

func TestTheOldestSessionIsClosedWhenTheLimitIsPassed(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.MaxSessions = 2 })
	for _, id := range []string{"a", "b"} {
		h.s.HandleServerMessage(start(id, "shop", "pod-"+id))
		h.src.pipe(t, "shop/pod-"+id)
	}
	h.s.HandleServerMessage(start("c", "shop", "pod-c"))
	e := h.ended(t)
	if e.GetSessionId() != "a" || e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_EVICTED_BY_LIMIT {
		t.Fatalf("%v", e)
	}
	h.src.pipe(t, "shop/pod-c")

	// And again: the next oldest is b, not a second notice for a.
	h.s.HandleServerMessage(start("d", "shop", "pod-d"))
	if e := h.ended(t); e.GetSessionId() != "b" {
		t.Fatalf("%v", e)
	}
	deadline := time.Now().Add(time.Second)
	for h.s.Active() != 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.s.Active() != 2 {
		t.Fatalf("%d sessions", h.s.Active())
	}
}

func TestTenConcurrentSessionsAreStable(t *testing.T) {
	h := newHarness(t, nil)
	for i := range 10 {
		id := string(rune('a' + i))
		h.s.HandleServerMessage(start(id, "shop", "pod-"+id))
	}
	for i := range 10 {
		id := string(rune('a' + i))
		w := h.src.pipe(t, "shop/pod-"+id)
		go func() { _, _ = w.Write([]byte("line from " + id + "\n")) }()
	}
	seen := map[string]bool{}
	for len(seen) < 10 {
		m := h.next(t)
		if m.GetLogEnded() != nil {
			t.Fatalf("a session ended: %v", m.GetLogEnded())
		}
		if c := m.GetLogChunk(); c != nil {
			seen[c.GetSessionId()] = true
		}
	}
	if h.s.Active() != 10 {
		t.Fatalf("%d active", h.s.Active())
	}
}

func TestHardTimeout(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Timeout = 80 * time.Millisecond })
	h.s.HandleServerMessage(start("s1", "shop", "web-1"))
	h.src.pipe(t, "shop/web-1")
	if e := h.ended(t); e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_TIMEOUT {
		t.Fatalf("%v", e)
	}
}

func TestWhyAnEndedLogEnded(t *testing.T) {
	t.Run("the pod was deleted", func(t *testing.T) {
		h := newHarness(t, nil)
		h.src.exists = false
		h.s.HandleServerMessage(start("s1", "shop", "web-1"))
		_ = h.src.pipe(t, "shop/web-1").Close()
		if e := h.ended(t); e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_POD_GONE {
			t.Fatalf("%v", e)
		}
	})
	t.Run("the pod does not exist", func(t *testing.T) {
		h := newHarness(t, nil)
		h.src.openErr = apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, "web-1")
		h.s.HandleServerMessage(start("s1", "shop", "web-1"))
		if e := h.ended(t); e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_POD_GONE {
			t.Fatalf("%v", e)
		}
	})
	t.Run("the container has not started", func(t *testing.T) {
		h := newHarness(t, nil)
		h.src.openErr = apierrors.NewBadRequest(`container "app" in pod "web-1" is waiting to start: ContainerCreating`)
		h.s.HandleServerMessage(start("s1", "shop", "web-1"))
		e := h.ended(t)
		if e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR || !strings.Contains(e.GetMessage(), "waiting to start") {
			t.Fatalf("%v", e)
		}
	})
	t.Run("forbidden", func(t *testing.T) {
		h := newHarness(t, nil)
		h.src.openErr = apierrors.NewForbidden(schema.GroupResource{Resource: "pods/log"}, "web-1", errors.New("no"))
		h.s.HandleServerMessage(start("s1", "shop", "web-1"))
		if e := h.ended(t); e.GetReason() != pb.LogSessionEndReason_LOG_SESSION_END_REASON_ERROR {
			t.Fatalf("%v", e)
		}
	})
	t.Run("an unknown failure is not quoted", func(t *testing.T) {
		h := newHarness(t, nil)
		h.src.openErr = errors.New("dial tcp 10.0.0.1: token=hunter2 refused")
		h.s.HandleServerMessage(start("s1", "shop", "web-1"))
		e := h.ended(t)
		if strings.Contains(e.GetMessage(), "hunter2") {
			t.Fatalf("an internal error reached the control plane: %q", e.GetMessage())
		}
	})
}

func TestADisconnectEndsSessionsWithoutTellingAnyone(t *testing.T) {
	h := newHarness(t, nil)
	h.s.HandleServerMessage(start("s1", "shop", "web-1"))
	h.src.pipe(t, "shop/web-1")
	h.s.Disconnected()
	h.quiet(t)
	deadline := time.Now().Add(time.Second)
	for h.s.Active() != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.s.Active() != 0 {
		t.Fatal("sessions outlived the connection")
	}
}

func TestADuplicateStartChangesNothing(t *testing.T) {
	h := newHarness(t, nil)
	h.s.HandleServerMessage(start("s1", "shop", "web-1"))
	h.src.pipe(t, "shop/web-1")
	h.s.HandleServerMessage(start("s1", "shop", "web-1"))
	h.quiet(t)
	if h.s.Active() != 1 || len(h.src.opened) != 1 {
		t.Fatalf("active %d opened %d", h.s.Active(), len(h.src.opened))
	}
}

func TestTheRateIsAppliedByWaitingNotDropping(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.BytesPerSec = 128 * 1024 })
	h.s.HandleServerMessage(start("s1", "shop", "web-1"))
	w := h.src.pipe(t, "shop/web-1")
	const total = 256 * 1024
	go func() {
		_, _ = w.Write(bytes.Repeat([]byte("y"), total))
		_ = w.Close()
	}()
	began := time.Now()
	got := 0
	for {
		m := h.next(t)
		if c := m.GetLogChunk(); c != nil {
			got += len(c.GetData())
			continue
		}
		break
	}
	if got != total {
		t.Fatalf("%d of %d bytes arrived: the rate limit dropped data", got, total)
	}
	// 256 KB at 128 KB/s with a 64 KB burst cannot take less than about a second and a half.
	if elapsed := time.Since(began); elapsed < time.Second {
		t.Fatalf("finished in %v: the rate limit did nothing", elapsed)
	}
}

func TestNeverWritesLogContentToItsOwnLog(t *testing.T) {
	h := newHarness(t, nil)
	h.s.HandleServerMessage(start("s1", "shop", "web-1"))
	w := h.src.pipe(t, "shop/web-1")
	go func() {
		_, _ = w.Write([]byte("password=CANARY-9f3a\n"))
		_ = w.Close()
	}()
	h.ended(t)
	if strings.Contains(h.logbuf.String(), "CANARY") {
		t.Fatal("log content reached the agent's own log")
	}
}
