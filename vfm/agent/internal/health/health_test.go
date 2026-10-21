package health

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/config"
)

// quietLogger keeps expected failure paths from printing during a green run.
func quietLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

func newTestServer(tb testing.TB, opts Options) *Server {
	tb.Helper()
	if opts.HealthAddr == "" {
		opts.HealthAddr = "127.0.0.1:0"
	}
	if opts.Logger == nil {
		opts.Logger = quietLogger()
	}
	srv, err := New(opts)
	if err != nil {
		tb.Fatalf("New: %v", err)
	}
	return srv
}

// get drives a handler through the health mux without opening a socket.
func get(tb testing.TB, srv *Server, path string) *httptest.ResponseRecorder {
	tb.Helper()
	recorder := httptest.NewRecorder()
	srv.healthMux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

func decode(tb testing.TB, recorder *httptest.ResponseRecorder) response {
	tb.Helper()
	var body response
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		tb.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	return body
}

func alwaysTrue() bool  { return true }
func alwaysFalse() bool { return false }

func TestNewRequiresHealthAddr(t *testing.T) {
	if _, err := New(Options{Logger: quietLogger()}); err == nil {
		t.Fatal("New should reject an empty HealthAddr")
	}
}

// TestLivenessIgnoresDependencies is the important liveness property: an API
// server outage must not restart every agent in the fleet.
func TestLivenessIgnoresDependencies(t *testing.T) {
	srv := newTestServer(t, Options{
		KubeProbe: func(context.Context) error { return errors.New("api server unreachable") },
		Leading:   alwaysFalse,
	})

	recorder := get(t, srv, PathHealthz)
	if recorder.Code != http.StatusOK {
		t.Errorf("GET %s = %d, want %d even with a failing dependency", PathHealthz, recorder.Code, http.StatusOK)
	}
	if body := decode(t, recorder); body.Status != statusOK {
		t.Errorf("status = %q, want %q", body.Status, statusOK)
	}
}

func TestReadinessReportsHealthyLeader(t *testing.T) {
	srv := newTestServer(t, Options{
		KubeProbe: func(context.Context) error { return nil },
		Leading:   alwaysTrue,
		Version:   "1.2.3",
	})

	recorder := get(t, srv, PathReadyz)
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET %s = %d, want %d", PathReadyz, recorder.Code, http.StatusOK)
	}
	body := decode(t, recorder)
	if body.Status != statusOK {
		t.Errorf("status = %q, want %q", body.Status, statusOK)
	}
	if !body.Leader {
		t.Error("leader = false, want true")
	}
	if body.Version != "1.2.3" {
		t.Errorf("version = %q, want %q", body.Version, "1.2.3")
	}
	if body.Checks[checkKubeAPI] != statusOK {
		t.Errorf("checks[%s] = %q, want %q", checkKubeAPI, body.Checks[checkKubeAPI], statusOK)
	}
	if body.Checks[checkLeadership] != statusLeader {
		t.Errorf("checks[%s] = %q, want %q", checkLeadership, body.Checks[checkLeadership], statusLeader)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}

func TestReadinessFailsWhenTheKubeProbeFails(t *testing.T) {
	const probeDetail = "dial tcp 10.0.0.1:443: connect: connection refused"

	srv := newTestServer(t, Options{
		KubeProbe: func(context.Context) error { return errors.New(probeDetail) },
		Leading:   alwaysTrue,
	})

	recorder := get(t, srv, PathReadyz)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET %s = %d, want %d", PathReadyz, recorder.Code, http.StatusServiceUnavailable)
	}
	body := decode(t, recorder)
	if body.Status != statusUnavailable {
		t.Errorf("status = %q, want %q", body.Status, statusUnavailable)
	}
	if body.Checks[checkKubeAPI] != statusFailed {
		t.Errorf("checks[%s] = %q, want %q", checkKubeAPI, body.Checks[checkKubeAPI], statusFailed)
	}
	// The probes are unauthenticated: detail belongs in the log, not the body.
	if strings.Contains(recorder.Body.String(), probeDetail) {
		t.Errorf("probe detail leaked into the response body: %s", recorder.Body.String())
	}
}

func TestReadinessProbeIsBounded(t *testing.T) {
	srv := newTestServer(t, Options{
		ProbeTimeout: 10 * time.Millisecond,
		KubeProbe: func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		},
		Leading: alwaysTrue,
	})

	done := make(chan int, 1)
	go func() { done <- get(t, srv, PathReadyz).Code }()

	select {
	case code := <-done:
		if code != http.StatusServiceUnavailable {
			t.Errorf("GET %s = %d, want %d when the probe times out", PathReadyz, code, http.StatusServiceUnavailable)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("GET %s did not return; the probe timeout is not enforced", PathReadyz)
	}
}

func TestReadinessLeadershipReporting(t *testing.T) {
	tests := []struct {
		name              string
		leading           func() bool
		requireLeadership bool
		wantCode          int
		wantCheck         string
	}{
		{
			name:      "standby replica stays ready by default",
			leading:   alwaysFalse,
			wantCode:  http.StatusOK,
			wantCheck: statusStandby,
		},
		{
			name:              "standby replica is unready when leadership is required",
			leading:           alwaysFalse,
			requireLeadership: true,
			wantCode:          http.StatusServiceUnavailable,
			wantCheck:         statusStandby,
		},
		{
			name:              "leader is ready when leadership is required",
			leading:           alwaysTrue,
			requireLeadership: true,
			wantCode:          http.StatusOK,
			wantCheck:         statusLeader,
		},
		{
			name:      "a nil Leading function reads as standby",
			wantCode:  http.StatusOK,
			wantCheck: statusStandby,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			srv := newTestServer(t, Options{
				KubeProbe:         func(context.Context) error { return nil },
				Leading:           test.leading,
				RequireLeadership: test.requireLeadership,
			})

			recorder := get(t, srv, PathReadyz)
			if recorder.Code != test.wantCode {
				t.Errorf("GET %s = %d, want %d", PathReadyz, recorder.Code, test.wantCode)
			}
			if got := decode(t, recorder).Checks[checkLeadership]; got != test.wantCheck {
				t.Errorf("checks[%s] = %q, want %q", checkLeadership, got, test.wantCheck)
			}
		})
	}
}

func TestProbesRejectOtherMethods(t *testing.T) {
	srv := newTestServer(t, Options{Leading: alwaysTrue})

	for _, path := range []string{PathHealthz, PathReadyz} {
		recorder := httptest.NewRecorder()
		srv.healthMux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, nil))
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s = %d, want %d", path, recorder.Code, http.StatusMethodNotAllowed)
		}
		if got := recorder.Header().Get("Allow"); got != "GET, HEAD" {
			t.Errorf("POST %s Allow = %q, want %q", path, got, "GET, HEAD")
		}
	}
}

func TestMetricsShareTheHealthListenerByDefault(t *testing.T) {
	srv := newTestServer(t, Options{Leading: alwaysTrue, Version: "1.2.3"})
	if len(srv.endpoints) != 1 {
		t.Fatalf("got %d endpoints, want 1 when no separate metrics address is set", len(srv.endpoints))
	}

	recorder := get(t, srv, PathMetrics)
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET %s = %d, want %d", PathMetrics, recorder.Code, http.StatusOK)
	}

	exposed := recorder.Body.String()
	leaderMetric := config.MetricNamespace + "_" + config.MetricSubsystem + "_leader"
	if !strings.Contains(exposed, leaderMetric+" 1") {
		t.Errorf("%s is not reported as 1 while leading:\n%s", leaderMetric, exposed)
	}
	if !strings.Contains(exposed, `version="1.2.3"`) {
		t.Errorf("build info does not carry the version:\n%s", exposed)
	}
}

func TestMetricsOnASeparateListener(t *testing.T) {
	srv := newTestServer(t, Options{
		HealthAddr:  "127.0.0.1:0",
		MetricsAddr: "127.0.0.1:1",
		Leading:     alwaysFalse,
	})
	if len(srv.endpoints) != 2 {
		t.Fatalf("got %d endpoints, want 2 for distinct health and metrics addresses", len(srv.endpoints))
	}
	if recorder := get(t, srv, PathMetrics); recorder.Code != http.StatusNotFound {
		t.Errorf("GET %s on the health listener = %d, want %d", PathMetrics, recorder.Code, http.StatusNotFound)
	}
}

func TestLeaderGaugeFollowsLeadership(t *testing.T) {
	leading := false
	srv := newTestServer(t, Options{Leading: func() bool { return leading }})

	if exposed := get(t, srv, PathMetrics).Body.String(); !strings.Contains(exposed, "_leader 0") {
		t.Errorf("leader gauge should be 0 before election:\n%s", exposed)
	}
	leading = true
	if exposed := get(t, srv, PathMetrics).Body.String(); !strings.Contains(exposed, "_leader 1") {
		t.Errorf("leader gauge should be 1 once elected:\n%s", exposed)
	}
}

// TestStartAndShutdown binds a loopback port to prove the listeners are opened
// before Start returns and released on Shutdown.
func TestStartAndShutdown(t *testing.T) {
	srv := newTestServer(t, Options{Leading: alwaysTrue})
	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

func TestStartReportsAnUnusableAddress(t *testing.T) {
	srv := newTestServer(t, Options{HealthAddr: "127.0.0.1:-1", Leading: alwaysTrue})
	if err := srv.Start(); err == nil {
		t.Fatal("Start should fail on an invalid bind address")
	}
}
