package gateway

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/identity"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

const fingerprint = "kube-system-uid-1234"

type harness struct {
	gw    *fakeGateway
	store *identity.MemoryStore
	mgr   *Manager
	up    atomic.Int32
}

func newHarness(t *testing.T, mutate func(*Options, *fakeGateway)) *harness {
	t.Helper()
	ca := newTestCA(t)
	h := &harness{gw: startFakeGateway(t, ca, nil), store: &identity.MemoryStore{}}
	opts := Options{
		Address:         h.gw.addr,
		BootstrapCA:     ca.pem,
		EnrollmentToken: "bootstrap-token",
		Store:           h.store,
		Fingerprint:     func(context.Context) (string, error) { return fingerprint, nil },
		Hello: func(context.Context) *pb.Hello {
			return &pb.Hello{AgentVersion: "0.1.0", KubernetesVersion: "v1.31.0"}
		},
		AgentVersion:      "0.1.0",
		HeartbeatInterval: 50 * time.Millisecond,
		OnConnection: func(up bool) {
			if up {
				h.up.Add(1)
			}
		},
		Backoff: Backoff{Min: 10 * time.Millisecond, Max: 40 * time.Millisecond, Factor: 2, Rand: func() float64 { return 1 }},
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if mutate != nil {
		mutate(&opts, h.gw)
	}
	mgr, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	h.mgr = mgr
	return h
}

// run starts the manager and returns a stop function that also checks Run
// returned cleanly.
func (h *harness) run(t *testing.T) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.mgr.Run(ctx) }()
	return func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Run returned %v on a graceful stop", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("Run did not return after cancel")
		}
	}
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

func TestEnrollsOnFirstStartThenConnectsWithHelloAndHeartbeats(t *testing.T) {
	h := newHarness(t, nil)
	stop := h.run(t)
	defer stop()

	eventually(t, "connection", func() bool { return h.up.Load() == 1 })
	eventually(t, "heartbeats", func() bool { _, _, _, hb := h.gw.snapshot(); return hb >= 2 })

	id, err := h.store.Load(context.Background())
	if err != nil {
		t.Fatalf("identity was not persisted: %v", err)
	}
	if id.ClusterID != testClusterID {
		t.Errorf("cluster id = %q", id.ClusterID)
	}

	h.gw.mu.Lock()
	defer h.gw.mu.Unlock()
	hello := h.gw.hellos[0]
	if hello.GetProtocolVersion() != ProtocolVersion || hello.GetClusterFingerprint() != fingerprint {
		t.Errorf("hello did not carry protocol version and fingerprint: %+v", hello)
	}
	if hello.GetKubernetesVersion() != "v1.31.0" {
		t.Errorf("hello lost the caller's fields: %+v", hello)
	}
}

func TestDoesNotEnrollAgainOnceItHoldsAnIdentity(t *testing.T) {
	h := newHarness(t, nil)
	stop := h.run(t)
	eventually(t, "connection", func() bool { return h.up.Load() == 1 })
	stop()

	// A restart, with no token configured: it must reuse the stored identity.
	h.mgr.opts.EnrollmentToken = ""
	stop = h.run(t)
	defer stop()
	eventually(t, "second connection", func() bool { return h.up.Load() == 2 })

	if enrolls, _, _, _ := h.gw.snapshot(); enrolls != 1 {
		t.Errorf("enrolled %d times, want exactly once", enrolls)
	}
}

func TestWithoutIdentityOrTokenItReportsWhatIsMissing(t *testing.T) {
	h := newHarness(t, func(o *Options, _ *fakeGateway) { o.EnrollmentToken = "" })
	if err := h.mgr.session(context.Background()); !errors.Is(err, ErrNeedsEnrollment) {
		t.Fatalf("got %v, want ErrNeedsEnrollment", err)
	}
	if enrolls, _, _, _ := h.gw.snapshot(); enrolls != 0 {
		t.Errorf("it called Enroll without a token")
	}
}

func TestReconnectsAfterTheServerDropsTheStream(t *testing.T) {
	h := newHarness(t, func(_ *Options, g *fakeGateway) { g.configure(func() { g.dropAfterHello = true }) })
	stop := h.run(t)
	defer stop()

	eventually(t, "second connection", func() bool { _, _, c, _ := h.gw.snapshot(); return c >= 2 })
	eventually(t, "up again", func() bool { return h.up.Load() >= 2 })
	if enrolls, _, _, _ := h.gw.snapshot(); enrolls != 1 {
		t.Errorf("reconnecting must reuse the identity; enrolled %d times", enrolls)
	}
}

func TestKeepsRetryingWhenTheControlPlaneRefusesTheCertificate(t *testing.T) {
	h := newHarness(t, nil)
	stop := h.run(t)
	eventually(t, "first connection", func() bool { return h.up.Load() == 1 })

	h.gw.mu.Lock()
	h.gw.refuseConnect = 16 // codes.Unauthenticated
	h.gw.mu.Unlock()
	// Force a new session by dropping the live one.
	stop()
	stop = h.run(t)
	defer stop()

	eventually(t, "repeated refused attempts", func() bool { _, _, c, _ := h.gw.snapshot(); return c >= 4 })
}

func TestRenewsAtTwoThirdsOfTheLifetimeWithoutDroppingTheStream(t *testing.T) {
	h := newHarness(t, func(_ *Options, g *fakeGateway) { g.configure(func() { g.lifetime = 3 * time.Second }) })
	stop := h.run(t)
	defer stop()

	eventually(t, "connection", func() bool { return h.up.Load() == 1 })
	first, err := h.store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	eventually(t, "renewal", func() bool { _, r, _, _ := h.gw.snapshot(); return r >= 1 })
	eventually(t, "the renewed identity to be stored", func() bool {
		id, err := h.store.Load(context.Background())
		return err == nil && string(id.CertPEM) != string(first.CertPEM)
	})

	if _, _, connects, _ := h.gw.snapshot(); connects != 1 {
		t.Errorf("renewal reconnected (%d connects); it should not", connects)
	}
}

func TestGracefulShutdownClosesTheStream(t *testing.T) {
	h := newHarness(t, nil)
	stop := h.run(t)
	eventually(t, "connection", func() bool { return h.up.Load() == 1 })
	stop()

	select {
	case <-h.gw.closedByClient:
	case <-time.After(3 * time.Second):
		t.Fatal("the server never saw the client close the stream")
	}
}

func TestRefusesAControlPlaneThatIsNotSignedByThePinnedCA(t *testing.T) {
	ca, impostor := newTestCA(t), newTestCA(t)
	gw := startFakeGateway(t, ca, impostor) // serves a certificate from another CA
	store := &identity.MemoryStore{}
	mgr, err := New(Options{
		Address: gw.addr, BootstrapCA: ca.pem, EnrollmentToken: "bootstrap-token", Store: store,
		Fingerprint: func(context.Context) (string, error) { return fingerprint, nil },
		Hello:       func(context.Context) *pb.Hello { return &pb.Hello{} },
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := mgr.session(context.Background()); err == nil {
		t.Fatal("enrolled against a server the pinned CA did not sign")
	}
	if enrolls, _, _, _ := gw.snapshot(); enrolls != 0 {
		t.Errorf("the token reached an unverified server (%d Enroll calls)", enrolls)
	}
	if _, err := store.Load(context.Background()); !errors.Is(err, identity.ErrNotFound) {
		t.Errorf("an identity was stored")
	}
}

func TestRejectsABadTokenWithoutStoringAnything(t *testing.T) {
	h := newHarness(t, func(o *Options, _ *fakeGateway) { o.EnrollmentToken = "wrong" })
	if err := h.mgr.session(context.Background()); err == nil {
		t.Fatal("a wrong token enrolled")
	}
	if _, err := h.store.Load(context.Background()); !errors.Is(err, identity.ErrNotFound) {
		t.Errorf("an identity was stored after a refused enrollment")
	}
}

func TestSendQueuesUntilTheStreamIsUpAndReportsOverflow(t *testing.T) {
	h := newHarness(t, nil)
	for range cap(h.mgr.outbox) {
		if !h.mgr.Send(&pb.AgentMessage{}) {
			t.Fatal("queue refused a message before it was full")
		}
	}
	if h.mgr.Send(&pb.AgentMessage{}) {
		t.Error("a full queue must refuse, so producers drop and resync instead of blocking")
	}
}
