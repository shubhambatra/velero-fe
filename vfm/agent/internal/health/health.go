// Package health serves the agent's liveness, readiness and metrics endpoints
// (PLAN.md §4.1, §13).
//
// The split between the two probes is deliberate:
//
//   - /healthz answers "is this process alive", and nothing else. It must not
//     depend on the Kubernetes API or on the control plane, otherwise an
//     outage in either would restart every agent in the fleet at once.
//   - /readyz answers "can this replica do its job": it reflects whether the
//     Kubernetes client works and whether this replica holds the leader lease
//     (PLAN.md §3.2).
package health

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/config"
)

// Served paths.
const (
	PathHealthz = "/healthz"
	PathReadyz  = "/readyz"
	PathMetrics = "/metrics"
)

// Values reported in the probe response bodies.
const (
	statusOK          = "ok"
	statusUnavailable = "unavailable"
	statusFailed      = "failed"
	statusLeader      = "leader"
	statusStandby     = "standby"

	checkKubeAPI    = "kubernetes-api"
	checkLeadership = "leadership"
)

const (
	defaultProbeTimeout = 2 * time.Second

	// HTTP server timeouts. These are set explicitly rather than left at the
	// zero value, which means "no timeout" and is a trivial slowloris target.
	readHeaderTimeout = 5 * time.Second
	readTimeout       = 10 * time.Second
	writeTimeout      = 15 * time.Second
	idleTimeout       = 60 * time.Second
	maxHeaderBytes    = 1 << 14
)

// Probe reports whether a dependency is usable. It must honour the context
// and return quickly.
type Probe func(context.Context) error

// Options configures a [Server].
type Options struct {
	// HealthAddr is the bind address for /healthz and /readyz. Required.
	HealthAddr string

	// MetricsAddr is the bind address for /metrics. When empty or equal to
	// HealthAddr, metrics share the health listener.
	MetricsAddr string

	// KubeProbe checks API-server reachability. A nil probe is treated as
	// always healthy.
	KubeProbe Probe

	// ProbeTimeout bounds one readiness probe.
	ProbeTimeout time.Duration

	// Leading reports whether this replica holds the leader lease. A nil
	// function means "never leading".
	Leading func() bool

	// RequireLeadership makes /readyz report unavailable on a replica that
	// does not hold the lease. Off by default: with two replicas only one can
	// ever lead (PLAN.md §3.2), and a permanently unready standby stalls
	// Deployment rollouts. Leadership is always *reported*, in the response
	// body and as the `vfm_agent_leader` gauge, whatever this is set to.
	RequireLeadership bool

	// Version is reported in probe bodies and as a build-info metric label.
	Version string

	// Registry collects this binary's metrics. A nil registry means a fresh,
	// private one — the global default registry is deliberately not used, so
	// tests are isolated and nothing leaks in from a dependency.
	Registry *prometheus.Registry

	// Logger receives failures that have nowhere else to go. Defaults to
	// slog.Default().
	Logger *slog.Logger
}

// Server owns the HTTP listeners for probes and metrics.
type Server struct {
	opts      Options
	log       *slog.Logger
	registry  *prometheus.Registry
	healthMux *http.ServeMux
	endpoints []*endpoint
	wg        sync.WaitGroup
}

type endpoint struct {
	addr   string
	server *http.Server
}

// response is the probe response body. It carries no error detail: a probe
// error may quote a URL or token, and this endpoint is unauthenticated.
type response struct {
	Status  string            `json:"status"`
	Leader  bool              `json:"leader"`
	Version string            `json:"version,omitempty"`
	Checks  map[string]string `json:"checks,omitempty"`
}

// New registers the agent's metrics and builds the HTTP servers. It opens no
// listeners; call [Server.Start].
func New(opts Options) (*Server, error) {
	if opts.HealthAddr == "" {
		return nil, errors.New("health: HealthAddr is required")
	}
	if opts.ProbeTimeout <= 0 {
		opts.ProbeTimeout = defaultProbeTimeout
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	registry := opts.Registry
	if registry == nil {
		registry = prometheus.NewRegistry()
	}

	srv := &Server{opts: opts, log: logger, registry: registry}
	if err := srv.registerMetrics(); err != nil {
		return nil, err
	}

	srv.healthMux = http.NewServeMux()
	srv.healthMux.Handle(PathHealthz, srv.livenessHandler())
	srv.healthMux.Handle(PathReadyz, srv.readinessHandler())

	metricsHandler := promhttp.HandlerFor(registry, promhttp.HandlerOpts{
		ErrorHandling: promhttp.HTTPErrorOnError,
		Registry:      registry,
	})

	if opts.MetricsAddr == "" || opts.MetricsAddr == opts.HealthAddr {
		srv.healthMux.Handle(PathMetrics, metricsHandler)
		srv.endpoints = []*endpoint{newEndpoint(opts.HealthAddr, srv.healthMux)}
	} else {
		metricsMux := http.NewServeMux()
		metricsMux.Handle(PathMetrics, metricsHandler)
		srv.endpoints = []*endpoint{
			newEndpoint(opts.HealthAddr, srv.healthMux),
			newEndpoint(opts.MetricsAddr, metricsMux),
		}
	}
	return srv, nil
}

func newEndpoint(addr string, handler http.Handler) *endpoint {
	return &endpoint{
		addr: addr,
		server: &http.Server{
			Addr:              addr,
			Handler:           handler,
			ReadHeaderTimeout: readHeaderTimeout,
			ReadTimeout:       readTimeout,
			WriteTimeout:      writeTimeout,
			IdleTimeout:       idleTimeout,
			MaxHeaderBytes:    maxHeaderBytes,
		},
	}
}

// registerMetrics installs the process collectors plus the agent's own gauges.
func (s *Server) registerMetrics() error {
	gauges := []prometheus.Collector{
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Namespace: config.MetricNamespace,
			Subsystem: config.MetricSubsystem,
			Name:      "leader",
			Help:      "1 if this replica holds the leader lease and is executing, 0 otherwise.",
		}, func() float64 {
			if s.leading() {
				return 1
			}
			return 0
		}),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Namespace:   config.MetricNamespace,
			Subsystem:   config.MetricSubsystem,
			Name:        "build_info",
			Help:        "Always 1; the version is carried in the label.",
			ConstLabels: prometheus.Labels{"version": s.opts.Version},
		}, func() float64 { return 1 }),
	}
	for _, collector := range gauges {
		if err := s.registry.Register(collector); err != nil {
			return fmt.Errorf("health: register metrics collector: %w", err)
		}
	}
	return nil
}

// Start opens every listener and serves in the background. It returns once the
// listeners are bound, so a caller that reports "ready" afterwards is not
// lying, and a port clash fails startup instead of vanishing into a goroutine.
func (s *Server) Start() error {
	for _, ep := range s.endpoints {
		listener, err := net.Listen("tcp", ep.addr)
		if err != nil {
			return fmt.Errorf("health: listen on %s: %w", ep.addr, err)
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			if err := ep.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				s.log.Error("health server stopped unexpectedly", "addr", ep.addr, "error", err)
			}
		}()
		s.log.Info("serving health endpoints", "addr", ep.addr)
	}
	return nil
}

// Shutdown stops serving, waiting for in-flight requests until ctx expires.
func (s *Server) Shutdown(ctx context.Context) error {
	var errs []error
	for _, ep := range s.endpoints {
		if err := ep.server.Shutdown(ctx); err != nil {
			errs = append(errs, fmt.Errorf("shut down %s: %w", ep.addr, err))
		}
	}

	// Bound the wait: if Shutdown gave up, Serve may still be unwinding and
	// waiting forever would defeat the caller's shutdown deadline.
	drained := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(drained)
	}()
	select {
	case <-drained:
	case <-ctx.Done():
		errs = append(errs, fmt.Errorf("wait for health listeners: %w", ctx.Err()))
	}
	return errors.Join(errs...)
}

// livenessHandler reports that the process is running. It intentionally runs no
// checks — see the package comment.
func (s *Server) livenessHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedMethod(w, r) {
			return
		}
		s.writeJSON(w, http.StatusOK, response{
			Status:  statusOK,
			Leader:  s.leading(),
			Version: s.opts.Version,
		})
	})
}

// readinessHandler reports whether this replica can do its job.
func (s *Server) readinessHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedMethod(w, r) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), s.opts.ProbeTimeout)
		defer cancel()

		leading := s.leading()
		result := response{
			Status:  statusOK,
			Leader:  leading,
			Version: s.opts.Version,
			Checks:  make(map[string]string, 2),
		}
		code := http.StatusOK

		if s.opts.KubeProbe != nil {
			if err := s.opts.KubeProbe(ctx); err != nil {
				// The detail is logged, never served: this endpoint is
				// unauthenticated (PLAN.md §12.1).
				s.log.Warn("readiness check failed", "check", checkKubeAPI, "error", err)
				result.Checks[checkKubeAPI] = statusFailed
				code = http.StatusServiceUnavailable
			} else {
				result.Checks[checkKubeAPI] = statusOK
			}
		}

		if leading {
			result.Checks[checkLeadership] = statusLeader
		} else {
			result.Checks[checkLeadership] = statusStandby
			if s.opts.RequireLeadership {
				code = http.StatusServiceUnavailable
			}
		}

		if code != http.StatusOK {
			result.Status = statusUnavailable
		}
		s.writeJSON(w, code, result)
	})
}

// allowedMethod rejects anything but GET and HEAD, so the probes cannot be
// used as a generic endpoint.
func allowedMethod(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	w.Header().Set("Allow", "GET, HEAD")
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	return false
}

func (s *Server) leading() bool {
	if s.opts.Leading == nil {
		return false
	}
	return s.opts.Leading()
}

func (s *Server) writeJSON(w http.ResponseWriter, code int, body response) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		// The status line is already out; all that is left is a trace.
		s.log.Debug("writing probe response failed", "error", err)
	}
}
