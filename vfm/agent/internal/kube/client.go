// Package kube builds the agent's Kubernetes client and probes the API server.
//
// The client works in two modes: in-cluster with the agent's ServiceAccount
// credentials (how it runs in production, PLAN.md §3) and out-of-cluster from a
// kubeconfig for local development (PLAN.md §14.1, the `--dev` switch). Both
// are rate-limited and carry an explicit per-request timeout so a single agent
// can never hammer an API server (PLAN.md §13: under 100m CPU steady state).
package kube

import (
	"context"
	"errors"
	"fmt"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// livezPath is the cheapest API-server round trip available. It is a
// non-resource URL served to every authenticated client by Kubernetes' default
// `system:public-info-viewer` ClusterRole, so it needs no rule beyond the
// agent's own RBAC (PLAN.md §12.2 — "nothing more than this"). A cluster that
// has removed that default binding must grant `get` on the non-resource URL
// explicitly.
const livezPath = "/livez"

// maxProbeTimeout caps how long a readiness probe may wait for the API server,
// independent of the much longer timeout used for real requests.
const maxProbeTimeout = 5 * time.Second

// ErrNoRESTClient is returned by [Client.Ping] when the underlying clientset
// exposes no REST client to probe with.
var ErrNoRESTClient = errors.New("kube: discovery client exposes no REST client")

// Options configures [New].
type Options struct {
	// Dev selects out-of-cluster credentials from a kubeconfig.
	Dev bool

	// Kubeconfig is an explicit kubeconfig path; only used when Dev is set.
	// Empty falls back to the usual KUBECONFIG / ~/.kube/config discovery.
	Kubeconfig string

	// QPS and Burst are the client-side rate limit towards the API server.
	QPS   float64
	Burst int

	// Timeout bounds a single API request.
	Timeout time.Duration

	// UserAgent identifies the agent in API-server audit logs.
	UserAgent string
}

// Client is the agent's handle on the Kubernetes API.
type Client struct {
	clientset    kubernetes.Interface
	host         string
	probeTimeout time.Duration
}

// New builds a client from in-cluster credentials, or from a kubeconfig when
// Options.Dev is set. It performs no network I/O.
func New(opts Options) (*Client, error) {
	restCfg, err := restConfig(opts)
	if err != nil {
		return nil, err
	}

	// QPS/Burst are client-go's own token bucket; setting them is what keeps a
	// misbehaving controller loop from overwhelming a shared API server.
	restCfg.QPS = float32(opts.QPS)
	restCfg.Burst = opts.Burst
	restCfg.Timeout = opts.Timeout
	if opts.UserAgent != "" {
		restCfg.UserAgent = opts.UserAgent
	}

	clientset, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return nil, fmt.Errorf("build kubernetes client: %w", err)
	}

	return &Client{
		clientset:    clientset,
		host:         restCfg.Host,
		probeTimeout: probeTimeout(opts.Timeout),
	}, nil
}

// restConfig resolves credentials. In-cluster is the only production path:
// falling back to a kubeconfig silently would be a surprise, so the failure is
// reported with the fix in the message.
func restConfig(opts Options) (*rest.Config, error) {
	if !opts.Dev {
		restCfg, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("load in-cluster credentials (pass -dev to use a kubeconfig instead): %w", err)
		}
		return restCfg, nil
	}

	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if opts.Kubeconfig != "" {
		rules.ExplicitPath = opts.Kubeconfig
	}
	restCfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{}).ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("load kubeconfig: %w", err)
	}
	return restCfg, nil
}

// probeTimeout keeps readiness probes snappy even when regular requests are
// allowed to take much longer.
func probeTimeout(requestTimeout time.Duration) time.Duration {
	if requestTimeout > 0 && requestTimeout < maxProbeTimeout {
		return requestTimeout
	}
	return maxProbeTimeout
}

// Clientset returns the typed Kubernetes client. From M2 it is also the client
// the leader election Lease and the agent's own Secret are read through.
func (c *Client) Clientset() kubernetes.Interface { return c.clientset }

// Host returns the API server address this client is configured for. It is
// safe to log: a rest.Config host never carries credentials.
func (c *Client) Host() string { return c.host }

// Ping performs the cheapest possible API-server round trip and is what
// /readyz reports on. It never retries: the caller polls.
func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, c.probeTimeout)
	defer cancel()

	restClient := c.clientset.Discovery().RESTClient()
	if restClient == nil {
		return ErrNoRESTClient
	}
	if _, err := restClient.Get().AbsPath(livezPath).DoRaw(ctx); err != nil {
		return fmt.Errorf("probe %s: %w", livezPath, err)
	}
	return nil
}
