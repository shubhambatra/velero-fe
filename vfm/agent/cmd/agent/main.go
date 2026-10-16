// Command agent is the Velero Fleet Manager in-cluster agent.
//
// It runs as a Deployment with two replicas in the agent namespace and does
// nothing until it holds the leader Lease (PLAN.md §3.2). It dials out to the
// control plane and never listens for inbound connections except for its own
// probes and metrics (PLAN.md §1.1 P1).
//
// What this binary does today (M2 day 14): resolve and validate configuration,
// emit JSON logs, serve /healthz, /readyz and /metrics, build a Kubernetes
// client, win or follow the leader election and, as leader, enrol with the
// control plane, keep the mTLS stream open and execute the one command that
// exists so far, RefreshServerStatus — see [leaderTask]. It does not sync
// inventory yet.
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
	"reflect"
	"sync/atomic"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/config"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/dispatch"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/gateway"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/health"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/identity"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/inventory"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/kube"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/leader"
	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/velero"
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
// Lease: enrolling if needed, holding the control-plane stream open, and
// executing the typed commands that arrive on it (PLAN.md §5, M2 days 12 and 14).
//
// SEAM — the other operations (M4) register further handlers on the dispatcher;
// the Velero and core informers (M3 day 16 / M5 day 28) attach to the manager's
// Send queue.
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

		current := newPolicyHolder(ctx, logger, cfg, kubeClient)

		cache := dispatch.NewCache(dispatch.CacheSize)
		state := &dispatch.Store{Client: kubeClient.Clientset(), Namespace: cfg.Namespace, Name: cfg.StateConfigMap}
		if err := state.Load(ctx, cache); err != nil {
			// Not fatal: the worst case is a re-delivered command running twice, and
			// objects the agent creates are found by label before they are created.
			logger.Warn("could not load the executed-command cache; starting empty", "error", err)
		} else {
			logger.Info("executed-command cache loaded", "entries", cache.Len())
		}

		// The dispatcher needs the manager to send and the manager needs the
		// dispatcher to receive; the manager is bound after both exist.
		var manager *gateway.Manager
		dispatcher := dispatch.New(dispatch.Options{
			Send:   func(m *pb.AgentMessage) bool { return manager.Send(m) },
			Policy: current.get,
			Cache:  cache,
			NewID:  gateway.NewMessageID,
			Logger: logger,
		})
		dispatcher.Register("refresh_status", (&velero.StatusHandler{
			Dynamic:   kubeClient.Dynamic(),
			Namespace: cfg.VeleroNamespace,
		}).Handle)
		backupOps := &velero.BackupHandler{Dynamic: kubeClient.Dynamic(), Namespace: cfg.VeleroNamespace}
		dispatcher.Register("create_backup", backupOps.Create)
		dispatcher.Register("delete_backup", backupOps.Delete)
		dispatcher.Register("trigger_schedule", backupOps.TriggerSchedule)
		dispatcher.Register("fetch_download", (&velero.DownloadHandler{
			Dynamic:   kubeClient.Dynamic(),
			Namespace: cfg.VeleroNamespace,
			Send:      func(m *pb.AgentMessage) bool { return manager.Send(m) },
			NewID:     gateway.NewMessageID,
		}).Handle)

		syncer := inventory.New(inventory.Options{
			Dynamic:     kubeClient.Dynamic(),
			Discovery:   kubeClient.Clientset().Discovery(),
			Namespace:   cfg.VeleroNamespace,
			SendWait:    func(ctx context.Context, m *pb.AgentMessage) error { return manager.SendWait(ctx, m) },
			TrySend:     func(m *pb.AgentMessage) bool { return manager.Send(m) },
			NewID:       gateway.NewMessageID,
			Logger:      logger,
			ResyncEvery: cfg.ResyncInterval,
		})

		var err error
		manager, err = gateway.New(gateway.Options{
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
			Hello:             helloBuilder(kubeClient, current.get),
			AgentVersion:      version,
			HeartbeatInterval: cfg.HeartbeatInterval,
			OnMessage: func(m *pb.ServerMessage) {
				dispatcher.Handle(m)
				syncer.HandleServerMessage(m)
			},
			OnConnection: func(connected bool) {
				logger.Info("control-plane connection state", "connected", connected)
				syncer.SetConnected(connected)
			},
			Logger: logger,
		})
		if err != nil {
			return err
		}

		go syncer.Run(ctx)
		go state.Run(ctx, cache, stateSaveInterval, func(err error) {
			logger.Warn("could not persist the executed-command cache", "error", err)
		})

		logger.Info("leader task started",
			"control_plane_address", cfg.ControlPlaneAddress,
			"enrollment_token_set", cfg.EnrollmentToken != "",
		)
		err = manager.Run(ctx)
		dispatcher.Stop()
		logger.Info("leader task stopping")
		return err
	}
}

const (
	stateSaveInterval    = 30 * time.Second
	policyReloadInterval = 30 * time.Second
)

// policyHolder keeps the current policy and reloads it, so the owner can change
// the ConfigMap without restarting the agent.
type policyHolder struct{ current atomic.Pointer[policy.Policy] }

func (h *policyHolder) get() policy.Policy { return *h.current.Load() }

func newPolicyHolder(ctx context.Context, logger *slog.Logger, cfg *config.Config, k *kube.Client) *policyHolder {
	h := &policyHolder{}
	load := func() {
		p, err := policy.Load(ctx, k.Clientset(), cfg.Namespace, cfg.PolicyConfigMap)
		if err != nil {
			// Load returns a lockdown policy with the error: a broken policy must
			// never widen what the agent does.
			logger.Error("the agent policy is unreadable or invalid; refusing all changes until it is fixed", "error", err)
		}
		if old := h.current.Load(); old == nil || !reflect.DeepEqual(*old, p) {
			logger.Info("agent policy in effect",
				"allow_restore", p.AllowRestore, "allow_bsl_write", p.AllowBslWrite,
				"allow_log_streaming", p.AllowLogStreaming, "read_only", p.ReadOnly,
				"restore_denied_namespaces", p.RestoreDeniedNamespaces)
		}
		h.current.Store(&p)
	}
	load()
	go func() {
		ticker := time.NewTicker(policyReloadInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				load()
			}
		}
	}()
	return h
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
// policy is the one in effect, so the UI can show disabled actions with the
// reason (PLAN.md §5.5). The Velero version is not known here: the control plane
// asks for it with RefreshServerStatus once the stream is up.
func helloBuilder(k *kube.Client, currentPolicy func() policy.Policy) func(context.Context) *pb.Hello {
	return func(context.Context) *pb.Hello {
		hello := &pb.Hello{
			AgentVersion: version,
			ChartVersion: os.Getenv(config.EnvChartVersion),
			ImageTag:     os.Getenv(config.EnvImageTag),
			Policy:       currentPolicy().Proto(),
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
