package main

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"

	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/config"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/kube"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

func testConfig() *config.Config {
	cfg := config.Default()
	cfg.ControlPlaneAddress = "cp.example.com:8443"
	cfg.InstanceID = "vfm-agent-0"
	cfg.ClusterID = "018f3b2c-7e4a-7c3d-9b1e-2a4c6e8f0a12"
	cfg.ClusterName = "prod-eu-1"
	return cfg
}

// TestNewLoggerEmitsStableJSONFields pins the field names every agent log line
// carries, because the control plane and any log search depend on them
// (PLAN.md §4.1).
func TestNewLoggerEmitsStableJSONFields(t *testing.T) {
	var buf bytes.Buffer
	newLogger(testConfig(), &buf).Info("hello")

	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("log line is not JSON (%v): %s", err, buf.String())
	}

	want := map[string]string{
		"msg":          "hello",
		"level":        "INFO",
		"service":      config.ComponentName,
		"version":      version,
		"instance":     "vfm-agent-0",
		"cluster_id":   "018f3b2c-7e4a-7c3d-9b1e-2a4c6e8f0a12",
		"cluster_name": "prod-eu-1",
	}
	for field, expected := range want {
		if got, ok := line[field].(string); !ok || got != expected {
			t.Errorf("field %q = %v, want %q", field, line[field], expected)
		}
	}
	if _, ok := line["time"]; !ok {
		t.Errorf("log line has no time field: %s", buf.String())
	}
}

func TestNewLoggerHonoursLevel(t *testing.T) {
	cfg := testConfig()
	cfg.LogLevel = slog.LevelInfo

	var buf bytes.Buffer
	logger := newLogger(cfg, &buf)
	logger.Debug("suppressed")
	if buf.Len() != 0 {
		t.Errorf("debug line should be suppressed at info level: %s", buf.String())
	}

	logger.Warn("kept")
	if buf.Len() == 0 {
		t.Error("warn line should be emitted at info level")
	}
}

func TestNewLoggerUsesTextFormatInDevMode(t *testing.T) {
	cfg := testConfig()
	cfg.Dev = true
	cfg.LogFormat = config.LogFormatText

	var buf bytes.Buffer
	newLogger(cfg, &buf).Info("hello")

	line := buf.String()
	if json.Valid(buf.Bytes()) {
		t.Errorf("text format should not emit JSON: %s", line)
	}
	if !bytes.Contains(buf.Bytes(), []byte("service="+config.ComponentName)) {
		t.Errorf("text line is missing the service field: %s", line)
	}
}

// TestLeaderTaskStopsOnCancellation is the property the election depends on:
// losing the Lease cancels the task context and the task must return
// (PLAN.md §3.2). This agent has no identity and no bootstrap token, so the
// task sits in its retry loop — the state in which stopping is hardest.
func TestLeaderTaskStopsOnCancellation(t *testing.T) {
	cfg := testConfig()
	cfg.HeartbeatInterval = 10 * time.Millisecond
	kubeClient := kube.FromClientset(fake.NewClientset(), "https://fake")

	var buf bytes.Buffer
	task := leaderTask(newLogger(cfg, &buf), cfg, kubeClient)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- task(ctx) }()

	time.Sleep(25 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("leader task = %v, want nil on cancellation", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("leader task did not return after its context was cancelled")
	}
}

func TestLeaderTaskRefusesAnUnreadableCAFile(t *testing.T) {
	cfg := testConfig()
	cfg.ControlPlaneCAFile = "/nonexistent/ca.pem"
	task := leaderTask(newLogger(cfg, &bytes.Buffer{}), cfg, kube.FromClientset(fake.NewClientset(), "https://fake"))

	err := task(context.Background())
	if err == nil {
		t.Fatal("an unreadable CA file was ignored")
	}
	if bytes.Contains([]byte(err.Error()), []byte("/nonexistent")) {
		t.Errorf("the error echoes the path: %v", err)
	}
}

func TestClusterFingerprintIsTheKubeSystemUID(t *testing.T) {
	cs := fake.NewClientset(&corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: "kube-system", UID: types.UID("uid-abc")},
	})
	got, err := clusterFingerprint(kube.FromClientset(cs, "h"))(context.Background())
	if err != nil || got != "uid-abc" {
		t.Fatalf("fingerprint = %q, %v", got, err)
	}

	if _, err := clusterFingerprint(kube.FromClientset(fake.NewClientset(), "h"))(context.Background()); err == nil {
		t.Error("a cluster without kube-system produced a fingerprint")
	}
}

func TestHelloReportsTheDefaultPolicy(t *testing.T) {
	hello := helloBuilder(kube.FromClientset(fake.NewClientset(), "h"), policy.Default)(context.Background())
	p := hello.GetPolicy()
	if !p.GetAllowRestore() || p.GetReadOnly() {
		t.Errorf("default policy should allow restores and not be read-only: %+v", p)
	}
	for _, ns := range []string{"kube-system", "vfm-system", "velero"} {
		found := false
		for _, denied := range p.GetRestoreDeniedNamespaces() {
			found = found || denied == ns
		}
		if !found {
			t.Errorf("namespace %q is not in the default restore deny-list", ns)
		}
	}
}
