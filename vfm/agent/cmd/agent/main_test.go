package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/config"
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
// (PLAN.md §3.2).
func TestLeaderTaskStopsOnCancellation(t *testing.T) {
	cfg := testConfig()
	cfg.HeartbeatInterval = 10 * time.Millisecond

	var buf bytes.Buffer
	task := leaderTask(newLogger(cfg, &buf), cfg)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- task(ctx) }()

	time.Sleep(25 * time.Millisecond) // let at least one tick happen
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
