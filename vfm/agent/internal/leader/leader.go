// Package leader runs a task under Kubernetes Lease-based leader election.
//
// PLAN.md §3.2 deploys the agent with two replicas and a Lease in the agent's
// own namespace, of which only the leader connects to the control plane and
// executes commands. This package is the gate: it acquires the Lease, runs the
// task while the Lease is held, and stops the task the moment leadership is
// lost.
//
// The only Kubernetes object involved is a coordination.k8s.io Lease in the
// configured namespace, which is exactly what the agent's RBAC grants
// (PLAN.md §12.2).
package leader

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

// defaultTaskStopTimeout bounds how long [Run] waits for the task to return
// after it has been told to stop.
const defaultTaskStopTimeout = 10 * time.Second

var (
	// ErrInvalidConfig is wrapped when [Config] cannot be used.
	ErrInvalidConfig = errors.New("leader: invalid configuration")

	// ErrLostLeadership is returned when the Lease was lost while leading and
	// the process was not already shutting down. The caller is expected to
	// exit cleanly: a fresh process re-enters the election as a standby
	// (PLAN.md §3.2).
	ErrLostLeadership = errors.New("leader: lost the leader lease")

	// ErrTaskStopTimeout is returned when the task did not return within
	// Config.TaskStopTimeout after being asked to stop. It means work may
	// still be in flight, which is why the Lease is not released silently.
	ErrTaskStopTimeout = errors.New("leader: task did not stop in time")
)

// Task is the work performed only while this replica holds the Lease. It must
// return as soon as its context is cancelled.
type Task func(ctx context.Context) error

// Config describes one participant in the election.
type Config struct {
	// Clientset is used for the Lease only.
	Clientset kubernetes.Interface

	// Namespace and LeaseName identify the Lease object.
	Namespace string
	LeaseName string

	// Identity must be unique per replica; the pod name is the natural choice.
	Identity string

	LeaseDuration time.Duration
	RenewDeadline time.Duration
	RetryPeriod   time.Duration

	// TaskStopTimeout bounds the wait for the task to return once it has been
	// asked to stop. Defaults to 10s.
	TaskStopTimeout time.Duration

	// OnLeadershipChange is called with true when this replica starts leading
	// and false when it stops. It must not block; it exists so health and
	// metrics can follow leadership.
	OnLeadershipChange func(leading bool)

	// Logger defaults to slog.Default().
	Logger *slog.Logger
}

func (c *Config) validate() error {
	var problems []string
	if c.Clientset == nil {
		problems = append(problems, "Clientset is required")
	}
	if c.Namespace == "" {
		problems = append(problems, "Namespace is required")
	}
	if c.LeaseName == "" {
		problems = append(problems, "LeaseName is required")
	}
	if c.Identity == "" {
		problems = append(problems, "Identity is required and must be unique per replica")
	}
	if c.RetryPeriod <= 0 {
		problems = append(problems, "RetryPeriod must be greater than zero")
	}
	if c.RenewDeadline <= 0 {
		problems = append(problems, "RenewDeadline must be greater than zero")
	}
	if c.LeaseDuration <= 0 {
		problems = append(problems, "LeaseDuration must be greater than zero")
	}
	// Mirror client-go's own constraints so the failure names the field rather
	// than surfacing from inside the elector.
	if c.LeaseDuration > 0 && c.RenewDeadline > 0 && c.LeaseDuration <= c.RenewDeadline {
		problems = append(problems, "LeaseDuration must be greater than RenewDeadline")
	}
	if c.RenewDeadline > 0 && c.RetryPeriod > 0 &&
		c.RenewDeadline <= time.Duration(leaderelection.JitterFactor*float64(c.RetryPeriod)) {
		problems = append(problems, "RenewDeadline must be greater than RetryPeriod multiplied by the jitter factor")
	}
	if len(problems) > 0 {
		return fmt.Errorf("%w: %s", ErrInvalidConfig, strings.Join(problems, "; "))
	}
	return nil
}

func (c *Config) notify(leading bool) {
	if c.OnLeadershipChange != nil {
		c.OnLeadershipChange(leading)
	}
}

// Run blocks until ctx is cancelled, the task returns, or the Lease is lost.
//
// It returns nil for a clean shutdown (including on a replica that never
// became leader), [ErrLostLeadership] if the Lease was lost while leading, the
// task's own error if it failed, or [ErrTaskStopTimeout] if the task ignored
// its cancelled context.
func Run(ctx context.Context, cfg Config, task Task) error {
	if err := cfg.validate(); err != nil {
		return err
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	stopTimeout := cfg.TaskStopTimeout
	if stopTimeout <= 0 {
		stopTimeout = defaultTaskStopTimeout
	}

	// The election context deliberately does not inherit cancellation from
	// ctx. client-go releases the Lease as soon as its context is done without
	// waiting for the task to return (the documented caveat on
	// ReleaseOnCancel), which would let the standby replica start executing
	// while this one is still finishing. Ordering it by hand — stop the task
	// first, then end the election — keeps "only the leader executes" true
	// across a handover (PLAN.md §3.2).
	electionCtx, stopElection := context.WithCancel(context.WithoutCancel(ctx))
	defer stopElection()

	taskCtx, stopTask := context.WithCancel(ctx)
	defer stopTask()

	taskDone := make(chan error, 1)
	stopRequested := make(chan struct{})
	var stopOnce sync.Once
	requestStop := func() {
		stopOnce.Do(func() {
			stopTask()
			close(stopRequested)
		})
	}
	// A SIGTERM must stop a replica that is still waiting to be elected.
	defer context.AfterFunc(ctx, requestStop)()

	var taskStarted, lostLease atomic.Bool

	lock := &resourcelock.LeaseLock{
		LeaseMeta:  metav1.ObjectMeta{Name: cfg.LeaseName, Namespace: cfg.Namespace},
		Client:     cfg.Clientset.CoordinationV1(),
		LockConfig: resourcelock.ResourceLockConfig{Identity: cfg.Identity},
	}

	elector, err := leaderelection.NewLeaderElector(leaderelection.LeaderElectionConfig{
		Lock:            lock,
		LeaseDuration:   cfg.LeaseDuration,
		RenewDeadline:   cfg.RenewDeadline,
		RetryPeriod:     cfg.RetryPeriod,
		ReleaseOnCancel: true,
		Name:            cfg.LeaseName,
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: func(leaseCtx context.Context) {
				taskStarted.Store(true)
				cfg.notify(true)
				logger.Info("acquired the leader lease",
					"lease", cfg.LeaseName, "namespace", cfg.Namespace, "identity", cfg.Identity)

				// client-go cancels leaseCtx when the Lease is lost; mirror
				// that onto the task so losing leadership stops all work.
				defer context.AfterFunc(leaseCtx, requestStop)()
				taskDone <- task(taskCtx)
			},
			OnStoppedLeading: func() {
				cfg.notify(false)
				// This fires whenever the elector exits, even on a replica
				// that never led, so only count a loss while leading and only
				// when the process was not already shutting down.
				if taskStarted.Load() && ctx.Err() == nil {
					lostLease.Store(true)
				}
			},
			OnNewLeader: func(identity string) {
				if identity != cfg.Identity {
					logger.Info("another replica holds the leader lease",
						"holder", identity, "lease", cfg.LeaseName, "namespace", cfg.Namespace)
				}
			},
		},
	})
	if err != nil {
		return fmt.Errorf("configure leader election: %w", err)
	}

	// The supervisor ends the election only once the task has finished, which
	// is the ordering described above.
	result := make(chan error, 1)
	go func() {
		result <- awaitTask(taskDone, stopRequested, &taskStarted, stopTimeout)
		stopElection()
	}()

	elector.Run(electionCtx)

	if err := <-result; err != nil {
		return err
	}
	if lostLease.Load() {
		return ErrLostLeadership
	}
	return nil
}

// awaitTask blocks until the task finishes, or until a stop has been requested
// and the task has had stopTimeout to return.
func awaitTask(done <-chan error, stopRequested <-chan struct{}, started *atomic.Bool, stopTimeout time.Duration) error {
	select {
	case err := <-done:
		return err
	case <-stopRequested:
	}

	if !started.Load() {
		// Never elected: a standby replica shutting down is not an error.
		return nil
	}

	timer := time.NewTimer(stopTimeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		return fmt.Errorf("%w after %s", ErrTaskStopTimeout, stopTimeout)
	}
}
