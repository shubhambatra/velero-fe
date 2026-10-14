package leader

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
)

// validConfig is a configuration that passes validation. The clientset is a
// zero value: these tests never reach the API server, which is why they need
// no cluster. The elector itself is exercised against a real API server by the
// envtest suite that arrives with the connection manager (PLAN.md §15).
func validConfig() Config {
	return Config{
		Clientset:     &kubernetes.Clientset{},
		Namespace:     "vfm-system",
		LeaseName:     "vfm-agent",
		Identity:      "vfm-agent-0",
		LeaseDuration: 15 * time.Second,
		RenewDeadline: 10 * time.Second,
		RetryPeriod:   2 * time.Second,
	}
}

func TestConfigValidate(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*Config)
		wantErr string // empty means the configuration must be accepted
	}{
		{
			name:   "defaults are accepted",
			mutate: func(*Config) {},
		},
		{
			name:    "clientset is required",
			mutate:  func(c *Config) { c.Clientset = nil },
			wantErr: "Clientset",
		},
		{
			name:    "namespace is required",
			mutate:  func(c *Config) { c.Namespace = "" },
			wantErr: "Namespace",
		},
		{
			name:    "lease name is required",
			mutate:  func(c *Config) { c.LeaseName = "" },
			wantErr: "LeaseName",
		},
		{
			name:    "identity is required",
			mutate:  func(c *Config) { c.Identity = "" },
			wantErr: "Identity",
		},
		{
			name:    "lease duration must exceed the renew deadline",
			mutate:  func(c *Config) { c.LeaseDuration = c.RenewDeadline },
			wantErr: "LeaseDuration",
		},
		{
			name:    "renew deadline must exceed the jittered retry period",
			mutate:  func(c *Config) { c.RenewDeadline = 2 * time.Second; c.RetryPeriod = 2 * time.Second },
			wantErr: "RenewDeadline",
		},
		{
			name:    "retry period must be positive",
			mutate:  func(c *Config) { c.RetryPeriod = 0 },
			wantErr: "RetryPeriod",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := validConfig()
			test.mutate(&cfg)

			err := cfg.validate()
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("validate: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("validate accepted an invalid configuration")
			}
			if !errors.Is(err, ErrInvalidConfig) {
				t.Errorf("error does not wrap ErrInvalidConfig: %v", err)
			}
			if !strings.Contains(err.Error(), test.wantErr) {
				t.Errorf("error does not name %s: %v", test.wantErr, err)
			}
		})
	}
}

// TestRunRejectsInvalidConfig proves Run validates before touching the API.
func TestRunRejectsInvalidConfig(t *testing.T) {
	cfg := validConfig()
	cfg.Clientset = nil

	err := Run(context.Background(), cfg, func(context.Context) error { return nil })
	if !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("Run = %v, want ErrInvalidConfig", err)
	}
}

func TestConfigNotifyToleratesNilCallback(t *testing.T) {
	cfg := validConfig()
	cfg.notify(true) // must not panic

	var seen []bool
	cfg.OnLeadershipChange = func(leading bool) { seen = append(seen, leading) }
	cfg.notify(true)
	cfg.notify(false)
	if len(seen) != 2 || !seen[0] || seen[1] {
		t.Errorf("leadership changes = %v, want [true false]", seen)
	}
}

// TestAwaitTask covers the handover ordering: the Lease may only be released
// once the task has stopped (PLAN.md §3.2).
func TestAwaitTask(t *testing.T) {
	errTask := errors.New("task failed")

	t.Run("task error propagates", func(t *testing.T) {
		done := make(chan error, 1)
		done <- errTask
		if err := awaitTask(done, make(chan struct{}), startedFlag(true), time.Second); !errors.Is(err, errTask) {
			t.Fatalf("awaitTask = %v, want %v", err, errTask)
		}
	})

	t.Run("a replica that never led shuts down cleanly", func(t *testing.T) {
		stopRequested := make(chan struct{})
		close(stopRequested)
		if err := awaitTask(make(chan error, 1), stopRequested, startedFlag(false), time.Second); err != nil {
			t.Fatalf("awaitTask = %v, want nil", err)
		}
	})

	t.Run("a stopping task is waited for", func(t *testing.T) {
		done := make(chan error, 1)
		stopRequested := make(chan struct{})
		close(stopRequested)
		go func() {
			time.Sleep(10 * time.Millisecond)
			done <- nil
		}()
		if err := awaitTask(done, stopRequested, startedFlag(true), 2*time.Second); err != nil {
			t.Fatalf("awaitTask = %v, want nil", err)
		}
	})

	t.Run("a task that ignores cancellation is reported", func(t *testing.T) {
		stopRequested := make(chan struct{})
		close(stopRequested)
		err := awaitTask(make(chan error, 1), stopRequested, startedFlag(true), 10*time.Millisecond)
		if !errors.Is(err, ErrTaskStopTimeout) {
			t.Fatalf("awaitTask = %v, want ErrTaskStopTimeout", err)
		}
	})
}

func startedFlag(value bool) *atomic.Bool {
	flag := &atomic.Bool{}
	flag.Store(value)
	return flag
}
