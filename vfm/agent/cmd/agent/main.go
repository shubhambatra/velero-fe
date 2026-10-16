// Command agent is the Velero Fleet Manager in-cluster agent.
//
// It runs as a Deployment with two replicas in the agent namespace and does
// nothing until it holds the leader Lease (PLAN.md §3.2). It dials out to the
// control plane and never listens for inbound connections except for its own
// probes and metrics (PLAN.md §1.1 P1).
//
// What this binary does today (M2 day 12): resolve and validate configuration,
// emit JSON logs, serve /healthz, /readyz and /metrics, build a Kubernetes
// client, win or follow the leader election and, as leader, enrol with the
// control plane and keep the mTLS stream open — see [leaderTask]. It does not
// execute commands or sync inventory yet.
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

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/config"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/gateway"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/health"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/identity"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/kube"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/leader"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
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
		return leaderTask(logger, cfg, kubeClient)(ctx)
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
	}, leaderTask(logger, cfg, kubeClient))

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
// Lease: enrolling if needed, then holding the control-plane stream open with
// Hello, heartbeats, reconnects and certificate renewal (PLAN.md §5, M2 day 12).
//
// SEAM — command execution (day 14) and the Velero and core informers (M3 day
// 16 / M5 day 28) attach to the manager's OnMessage hook and Send queue.
func leaderTask(logger *slog.Logger, cfg *config.Config, kubeClient *kube.Client) leader.Task {
	return func(ctx context.Context) error {
		var bootstrapCA []byte
		if cfg.ControlPlaneCAFile != "" {
			var err error
			bootstrapCA, err = os.ReadFile(cfg.ControlPlaneCAFile) //nolint:gosec // operator-supplied configuration, not request input
			if err != nil {
				// The path is not echoed: in dev it may point into a home directory.
				return errors.New("cannot read the control-plane CA file")
			}
		}

		manager, err := gateway.New(gateway.Options{
			Address:         cfg.ControlPlaneAddress,
			ServerName:      cfg.ServerName,
			BootstrapCA:     bootstrapCA,
			EnrollmentToken: cfg.EnrollmentToken,
			Store: &identity.SecretStore{
				Client:    kubeClient.Clientset(),
				Namespace: cfg.Namespace,
				Name:      cfg.CredentialsSecret,
			},
			Fingerprint:       clusterFingerprint(kubeClient),
			Hello:             helloBuilder(kubeClient),
			AgentVersion:      version,
			HeartbeatInterval: cfg.HeartbeatInterval,
			OnConnection: func(connected bool) {
				logger.Info("control-plane connection state", "connected", connected)
			},
			Logger: logger,
		})
		if err != nil {
			return err
		}

		logger.Info("leader task started",
			"control_plane_address", cfg.ControlPlaneAddress,
			"enrollment_token_set", cfg.EnrollmentToken != "",
		)
		err = manager.Run(ctx)
		logger.Info("leader task stopping")
		return err
	}
}

// clusterFingerprint is the UID of the kube-system namespace (PLAN.md §5.1
// step 3): stable for the life of a cluster and different in every other, so
// the control plane can tell the same agent installed into a new cluster.
func clusterFingerprint(k *kube.Client) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		ns, err := k.Clientset().CoreV1().Namespaces().Get(ctx, "kube-system", metav1.GetOptions{})
		if err != nil {
			return "", fmt.Errorf("read the kube-system namespace: %w", err)
		}
		return string(ns.UID), nil
	}
}

// helloBuilder reports what the agent knows about itself and its cluster. The
// policy is the built-in default (PLAN.md §5.5) until day 14 loads the
// `vfm-agent-policy` ConfigMap; no command executes before then, so the
// default is also what is enforced.
func helloBuilder(k *kube.Client) func(context.Context) *pb.Hello {
	return func(context.Context) *pb.Hello {
		hello := &pb.Hello{
			AgentVersion: version,
			ChartVersion: os.Getenv("VFM_AGENT_CHART_VERSION"),
			ImageTag:     os.Getenv("VFM_AGENT_IMAGE_TAG"),
			Policy: &pb.AgentPolicy{
				AllowRestore:              true,
				RestoreDeniedNamespaces:   []string{"kube-system", "vfm-system", "velero"},
				AllowBslWrite:             true,
				AllowLogStreaming:         true,
				LogStreamDeniedNamespaces: []string{},
			},
		}
		if v, err := k.Clientset().Discovery().ServerVersion(); err == nil {
			hello.KubernetesVersion = v.GitVersion
		}
		return hello
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
