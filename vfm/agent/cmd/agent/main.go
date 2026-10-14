// Command agent is the Velero Fleet Manager in-cluster agent.
//
// It runs as a Deployment with two replicas in the agent namespace and does
// nothing until it holds the leader Lease (PLAN.md §3.2). It dials out to the
// control plane and never listens for inbound connections except for its own
// probes and metrics (PLAN.md §1.1 P1).
//
// What this binary does today (M0 day 3): resolve and validate configuration,
// emit JSON logs, serve /healthz, /readyz and /metrics, build a Kubernetes
// client, and win or follow the leader election. The leader task is an empty
// loop with a marked seam — see [leaderTask].
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/config"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/health"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/kube"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/leader"
)

// version is the agent version reported in logs, metrics and (from M2) in the
// Hello message. Override it at build time:
//
//	go build -ldflags "-X main.version=$(git describe --tags --always)" ./cmd/agent
var version = "dev"

func main() {
	err := run(os.Args[1:])
	switch {
	case err == nil:
		return
	case errors.Is(err, flag.ErrHelp):
		// The flag package has already printed usage.
		return
	default:
		_, _ = fmt.Fprintf(os.Stderr, "%s: %v\n", config.ComponentName, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cfg, err := config.Load(args, os.LookupEnv)
	if err != nil {
		// Configuration errors are printed before the logger exists, because
		// the logger is configured by the very values that were rejected.
		return err
	}

	logger := newLogger(cfg, os.Stdout)
	slog.SetDefault(logger)
	// cfg implements slog.LogValuer, so this line cannot spill a sensitive
	// value (PLAN.md §12.1).
	logger.Info("starting", "product", config.ProductName, "config", cfg)

	// SIGTERM is what Kubernetes sends before the grace period; SIGINT is
	// Ctrl-C in development.
	ctx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	kubeClient, err := kube.New(kube.Options{
		Dev:        cfg.Dev,
		Kubeconfig: cfg.KubeconfigPath,
		QPS:        cfg.KubeQPS,
		Burst:      cfg.KubeBurst,
		Timeout:    cfg.KubeTimeout,
		UserAgent:  cfg.UserAgent(version),
	})
	if err != nil {
		return fmt.Errorf("kubernetes client: %w", err)
	}
	logger.Info("kubernetes client ready", "api_server", kubeClient.Host(), "dev", cfg.Dev)

	// leading is read by the readiness probe and the leader gauge, and written
	// by the election callbacks.
	var leading atomic.Bool

	healthServer, err := health.New(health.Options{
		HealthAddr:        cfg.HealthAddr,
		MetricsAddr:       cfg.MetricsAddr,
		KubeProbe:         kubeClient.Ping,
		Leading:           leading.Load,
		RequireLeadership: cfg.ReadyRequiresLeadership,
		Version:           version,
		Logger:            logger,
	})
	if err != nil {
		return err
	}
	if err := healthServer.Start(); err != nil {
		return err
	}
	defer shutdownHealthServer(logger, healthServer, cfg.ShutdownTimeout)

	if !cfg.LeaderElection {
		// Supported for a single-replica development run only; a Deployment
		// with two replicas must elect (PLAN.md §3.2).
		logger.Warn("leader election is disabled: this replica will run unconditionally")
		leading.Store(true)
		defer leading.Store(false)
		return leaderTask(logger, cfg)(ctx)
	}

	err = leader.Run(ctx, leader.Config{
		Clientset:          kubeClient.Clientset(),
		Namespace:          cfg.Namespace,
		LeaseName:          cfg.LeaseName,
		Identity:           cfg.InstanceID,
		LeaseDuration:      cfg.LeaseDuration,
		RenewDeadline:      cfg.LeaseRenewDeadline,
		RetryPeriod:        cfg.LeaseRetryPeriod,
		TaskStopTimeout:    cfg.ShutdownTimeout,
		OnLeadershipChange: leading.Store,
		Logger:             logger,
	}, leaderTask(logger, cfg))

	switch {
	case errors.Is(err, leader.ErrLostLeadership):
		// Not a failure: the standby replica has taken over. Exiting cleanly
		// lets this pod restart and re-enter the election as a standby.
		logger.Warn("lost the leader lease, exiting so the standby replica takes over")
		return nil
	case err != nil:
		return err
	}

	logger.Info("shutdown complete")
	return nil
}

// leaderTask returns the work performed only while this replica holds the
// Lease.
//
// SEAM — this function is deliberately inert. The gRPC connection manager
// (enrollment, mTLS Connect, Hello, heartbeats every HeartbeatInterval,
// reconnect with backoff and jitter) lands in M2 day 12, and the Velero and
// core informers in M3 day 16 / M5 day 28. Until then it only ticks, so
// nothing here can be mistaken for a working connection (PLAN.md §0 rule 7).
func leaderTask(logger *slog.Logger, cfg *config.Config) leader.Task {
	return func(ctx context.Context) error {
		logger.Info("leader task started",
			"heartbeat_interval", cfg.HeartbeatInterval.String(),
			"control_plane_address", cfg.ControlPlaneAddress,
			"connected", false,
		)

		ticker := time.NewTicker(cfg.HeartbeatInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				logger.Info("leader task stopping")
				return nil
			case <-ticker.C:
				logger.Debug("heartbeat tick: no control-plane connection yet (M2 day 12)")
			}
		}
	}
}

// newLogger builds the structured logger. JSON is mandatory in production
// (PLAN.md §4.1); the fixed attributes make fleet-wide log search uniform
// across agents (PLAN.md §13).
func newLogger(cfg *config.Config, out io.Writer) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}

	var handler slog.Handler
	if cfg.LogFormat == config.LogFormatText {
		handler = slog.NewTextHandler(out, opts)
	} else {
		handler = slog.NewJSONHandler(out, opts)
	}

	return slog.New(handler).With(
		slog.String("service", config.ComponentName),
		slog.String("version", version),
		slog.String("instance", cfg.InstanceID),
		slog.String("cluster_id", cfg.ClusterID),
		slog.String("cluster_name", cfg.ClusterName),
	)
}

// shutdownHealthServer stops the probe listeners within a bounded deadline.
// The deadline starts from a fresh context: the signal context is already
// cancelled by the time this runs, which would make Shutdown return at once
// and drop in-flight probe responses.
func shutdownHealthServer(logger *slog.Logger, server *health.Server, timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Error("health server shutdown failed", "error", err)
	}
}
