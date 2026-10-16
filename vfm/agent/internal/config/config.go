// Package config resolves the agent's configuration from defaults,
// environment variables and command-line flags, validates it, and makes it
// safe to log.
//
// Two rules shape this package:
//
//   - Fail fast and completely. Startup reports *every* offending setting at
//     once, naming the environment variable and the flag, so an operator fixes
//     one deployment instead of restarting into the next error.
//   - Never log a value that could be sensitive (PLAN.md §12.1). Error messages
//     and [Config.LogValue] carry setting *names* and reasons only. The parse
//     errors from the standard library are deliberately discarded because they
//     quote the offending value.
package config

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Supported log formats. PLAN.md §4.1 requires JSON logs; text is a
// development convenience and is only accepted together with Dev.
const (
	LogFormatJSON = "json"
	LogFormatText = "text"
)

// Environment variables read by the agent. Every one has a matching flag,
// which takes precedence (see [Load]).
const (
	EnvControlPlaneAddress = EnvPrefix + "CONTROL_PLANE_ADDRESS"
	EnvControlPlaneCAFile  = EnvPrefix + "CONTROL_PLANE_CA_FILE"
	EnvServerName          = EnvPrefix + "SERVER_NAME"
	EnvCredentialsSecret   = EnvPrefix + "CREDENTIALS_SECRET"
	// EnvEnrollmentToken has no flag on purpose: a flag would sit in the process
	// list for anyone on the node to read. The chart injects it from a Secret.
	EnvEnrollmentToken         = EnvPrefix + "ENROLLMENT_TOKEN"
	EnvPolicyConfigMap         = EnvPrefix + "POLICY_CONFIGMAP"
	EnvStateConfigMap          = EnvPrefix + "STATE_CONFIGMAP"
	EnvVeleroNamespace         = EnvPrefix + "VELERO_NAMESPACE"
	EnvClusterID               = EnvPrefix + "CLUSTER_ID"
	EnvClusterName             = EnvPrefix + "CLUSTER_NAME"
	EnvInstanceID              = EnvPrefix + "INSTANCE_ID"
	EnvNamespace               = EnvPrefix + "NAMESPACE"
	EnvKubeconfig              = EnvPrefix + "KUBECONFIG"
	EnvDev                     = EnvPrefix + "DEV"
	EnvHealthAddr              = EnvPrefix + "HEALTH_ADDR"
	EnvMetricsAddr             = EnvPrefix + "METRICS_ADDR"
	EnvLogLevel                = EnvPrefix + "LOG_LEVEL"
	EnvLogFormat               = EnvPrefix + "LOG_FORMAT"
	EnvHeartbeatInterval       = EnvPrefix + "HEARTBEAT_INTERVAL"
	EnvLeaderElection          = EnvPrefix + "LEADER_ELECTION"
	EnvLeaseName               = EnvPrefix + "LEASE_NAME"
	EnvLeaseDuration           = EnvPrefix + "LEASE_DURATION"
	EnvLeaseRenewDeadline      = EnvPrefix + "LEASE_RENEW_DEADLINE"
	EnvLeaseRetryPeriod        = EnvPrefix + "LEASE_RETRY_PERIOD"
	EnvReadyRequiresLeadership = EnvPrefix + "READY_REQUIRES_LEADERSHIP"
	EnvShutdownTimeout         = EnvPrefix + "SHUTDOWN_TIMEOUT"
	EnvKubeQPS                 = EnvPrefix + "KUBE_QPS"
	EnvKubeBurst               = EnvPrefix + "KUBE_BURST"
	EnvKubeTimeout             = EnvPrefix + "KUBE_TIMEOUT"
)

// setting pairs an environment variable with its flag so a problem can name
// both without a second mapping to keep in sync.
type setting struct {
	env  string
	flag string
}

var (
	settingControlPlaneAddress     = setting{EnvControlPlaneAddress, "control-plane-address"}
	settingControlPlaneCAFile      = setting{EnvControlPlaneCAFile, "control-plane-ca-file"}
	settingServerName              = setting{EnvServerName, "server-name"}
	settingCredentialsSecret       = setting{EnvCredentialsSecret, "credentials-secret"}
	settingPolicyConfigMap         = setting{EnvPolicyConfigMap, "policy-configmap"}
	settingStateConfigMap          = setting{EnvStateConfigMap, "state-configmap"}
	settingVeleroNamespace         = setting{EnvVeleroNamespace, "velero-namespace"}
	settingEnrollmentToken         = setting{env: EnvEnrollmentToken}
	settingClusterID               = setting{EnvClusterID, "cluster-id"}
	settingClusterName             = setting{EnvClusterName, "cluster-name"}
	settingInstanceID              = setting{EnvInstanceID, "instance-id"}
	settingNamespace               = setting{EnvNamespace, "namespace"}
	settingKubeconfig              = setting{EnvKubeconfig, "kubeconfig"}
	settingDev                     = setting{EnvDev, "dev"}
	settingHealthAddr              = setting{EnvHealthAddr, "health-addr"}
	settingMetricsAddr             = setting{EnvMetricsAddr, "metrics-addr"}
	settingLogLevel                = setting{EnvLogLevel, "log-level"}
	settingLogFormat               = setting{EnvLogFormat, "log-format"}
	settingHeartbeatInterval       = setting{EnvHeartbeatInterval, "heartbeat-interval"}
	settingLeaderElection          = setting{EnvLeaderElection, "leader-election"}
	settingLeaseName               = setting{EnvLeaseName, "lease-name"}
	settingLeaseDuration           = setting{EnvLeaseDuration, "lease-duration"}
	settingLeaseRenewDeadline      = setting{EnvLeaseRenewDeadline, "lease-renew-deadline"}
	settingLeaseRetryPeriod        = setting{EnvLeaseRetryPeriod, "lease-retry-period"}
	settingReadyRequiresLeadership = setting{EnvReadyRequiresLeadership, "ready-requires-leadership"}
	settingShutdownTimeout         = setting{EnvShutdownTimeout, "shutdown-timeout"}
	settingKubeQPS                 = setting{EnvKubeQPS, "kube-qps"}
	settingKubeBurst               = setting{EnvKubeBurst, "kube-burst"}
	settingKubeTimeout             = setting{EnvKubeTimeout, "kube-timeout"}
)

// redactedValue replaces any value that must not reach a log line.
const redactedValue = "<redacted>"

// leaseJitterFactor mirrors k8s.io/client-go/tools/leaderelection.JitterFactor.
// It is duplicated here so this package stays dependency-free (and therefore
// fast to test); [Config.validate] rejects timings client-go would reject at
// runtime, turning a late failure into a named startup error.
const leaseJitterFactor = 1.2

var (
	// dns1123Label validates a Kubernetes namespace.
	dns1123Label = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	// dns1123Subdomain validates a Kubernetes object name (the Lease).
	dns1123Subdomain = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)
	// uuidPattern validates the control-plane-issued cluster ID (UUIDv7 per
	// PLAN.md §9); the variant nibble is left unchecked on purpose.
	uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// Config is the agent's fully resolved configuration. It is read-only after
// [Load] returns.
type Config struct {
	// ControlPlaneAddress is the agent gateway the agent dials out to. The
	// agent never listens for inbound connections (PLAN.md §1.1 P1).
	ControlPlaneAddress string

	// ControlPlaneCAFile is the PEM CA bundle the agent pins the control plane
	// to. Only needed until the first enrollment, after which the CA stored with
	// the credentials is used.
	ControlPlaneCAFile string

	// ServerName overrides the TLS name checked against the gateway's
	// certificate; empty means the host of ControlPlaneAddress.
	ServerName string

	// CredentialsSecret names the Secret in Namespace that holds the agent's
	// private key, certificate and the CA (PLAN.md §5.1 step 3).
	CredentialsSecret string

	// PolicyConfigMap names the ConfigMap holding the agent-side policy
	// (PLAN.md §5.5). Set by the cluster owner at install time; the control plane
	// cannot change it.
	PolicyConfigMap string

	// StateConfigMap names the ConfigMap the agent persists its executed-command
	// cache to, so a restart still recognises a re-delivered command.
	StateConfigMap string

	// VeleroNamespace is where Velero runs and where the agent creates its
	// requests.
	VeleroNamespace string

	// EnrollmentToken is the one-time bootstrap token. Environment only, and
	// never logged; unused once the agent holds a certificate.
	EnrollmentToken string

	// ClusterID is assigned by the control plane; empty until enrollment
	// (PLAN.md §5.1, M2 day 11).
	ClusterID string

	// ClusterName is a human-readable label used only in logs.
	ClusterName string

	// InstanceID identifies this replica and is the leader-election identity.
	// It defaults to the hostname, which in a Deployment is the pod name.
	InstanceID string

	// Namespace is the namespace holding the agent's Lease, Secret and
	// ConfigMap (PLAN.md §12.2).
	Namespace string

	// KubeconfigPath is only honoured together with Dev.
	KubeconfigPath string

	// Dev runs the agent out-of-cluster against a kubeconfig (PLAN.md §14.1).
	Dev bool

	HealthAddr  string
	MetricsAddr string

	LogLevel  slog.Level
	LogFormat string

	// HeartbeatInterval is the gap between heartbeats on the gateway stream
	// (PLAN.md §5.2). The stream itself arrives in M2 day 12.
	HeartbeatInterval time.Duration

	// LeaderElection gates all work on holding the Lease (PLAN.md §3.2).
	LeaderElection     bool
	LeaseName          string
	LeaseDuration      time.Duration
	LeaseRenewDeadline time.Duration
	LeaseRetryPeriod   time.Duration

	// ReadyRequiresLeadership makes /readyz fail on a non-leading replica.
	// Off by default: with two replicas (PLAN.md §3.2) only one can ever lead,
	// and a permanently unready standby stalls Deployment rollouts.
	ReadyRequiresLeadership bool

	// ShutdownTimeout bounds graceful shutdown.
	ShutdownTimeout time.Duration

	// Client-side rate limit and timeout for the Kubernetes API (PLAN.md §13:
	// the agent must stay small and must not hammer the API server).
	KubeQPS     float64
	KubeBurst   int
	KubeTimeout time.Duration
}

// Default returns the configuration the agent starts from, before environment
// variables and flags are applied.
func Default() *Config {
	return &Config{
		InstanceID:         defaultInstanceID(),
		Namespace:          AgentNamespace,
		CredentialsSecret:  DefaultCredentialsSecret,
		PolicyConfigMap:    DefaultPolicyConfigMap,
		StateConfigMap:     DefaultStateConfigMap,
		VeleroNamespace:    DefaultVeleroNamespace,
		HealthAddr:         ":8081",
		MetricsAddr:        ":9090",
		LogLevel:           slog.LevelInfo,
		LogFormat:          LogFormatJSON,
		HeartbeatInterval:  15 * time.Second, // PLAN.md §5.2
		LeaderElection:     true,
		LeaseName:          DefaultLeaseName,
		LeaseDuration:      15 * time.Second, // client-go core-client defaults
		LeaseRenewDeadline: 10 * time.Second,
		LeaseRetryPeriod:   2 * time.Second,
		ShutdownTimeout:    20 * time.Second,
		KubeQPS:            20,
		KubeBurst:          30,
		KubeTimeout:        30 * time.Second,
	}
}

// defaultInstanceID uses the hostname, which is the pod name inside a
// Deployment and is therefore unique per replica.
func defaultInstanceID() string {
	host, err := os.Hostname()
	if err != nil {
		return ""
	}
	return host
}

// Load resolves configuration from defaults, then environment variables, then
// command-line flags — each layer overriding the previous one — and validates
// the result.
//
// getenv is injected so tests need no process environment; production callers
// pass os.LookupEnv. An explicitly empty variable counts as "set to empty" and
// clears the default, which is what makes a missing required value detectable.
//
// On rejection the returned error wraps [ErrInvalid] and is an [*Error]
// listing every offending setting. If args asks for help, the error wraps
// flag.ErrHelp and usage has already been printed.
func Load(args []string, getenv func(string) (string, bool)) (*Config, error) {
	cfg := Default()
	probs := &problems{}

	cfg.applyEnv(getenv, probs)
	if err := cfg.applyFlags(args, probs); err != nil {
		return nil, err
	}
	cfg.validate(probs)

	if err := probs.err(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// applyEnv overlays environment variables onto cfg.
func (c *Config) applyEnv(getenv func(string) (string, bool), probs *problems) {
	env := envReader{getenv: getenv, probs: probs}

	env.str(settingControlPlaneAddress, &c.ControlPlaneAddress)
	env.str(settingControlPlaneCAFile, &c.ControlPlaneCAFile)
	env.str(settingServerName, &c.ServerName)
	env.str(settingCredentialsSecret, &c.CredentialsSecret)
	env.str(settingPolicyConfigMap, &c.PolicyConfigMap)
	env.str(settingStateConfigMap, &c.StateConfigMap)
	env.str(settingVeleroNamespace, &c.VeleroNamespace)
	env.str(settingEnrollmentToken, &c.EnrollmentToken)
	env.str(settingClusterID, &c.ClusterID)
	env.str(settingClusterName, &c.ClusterName)
	env.str(settingInstanceID, &c.InstanceID)
	env.str(settingNamespace, &c.Namespace)
	env.str(settingKubeconfig, &c.KubeconfigPath)
	env.boolean(settingDev, &c.Dev)
	env.str(settingHealthAddr, &c.HealthAddr)
	env.str(settingMetricsAddr, &c.MetricsAddr)
	env.level(settingLogLevel, &c.LogLevel)
	env.str(settingLogFormat, &c.LogFormat)
	env.duration(settingHeartbeatInterval, &c.HeartbeatInterval)
	env.boolean(settingLeaderElection, &c.LeaderElection)
	env.str(settingLeaseName, &c.LeaseName)
	env.duration(settingLeaseDuration, &c.LeaseDuration)
	env.duration(settingLeaseRenewDeadline, &c.LeaseRenewDeadline)
	env.duration(settingLeaseRetryPeriod, &c.LeaseRetryPeriod)
	env.boolean(settingReadyRequiresLeadership, &c.ReadyRequiresLeadership)
	env.duration(settingShutdownTimeout, &c.ShutdownTimeout)
	env.float(settingKubeQPS, &c.KubeQPS)
	env.integer(settingKubeBurst, &c.KubeBurst)
	env.duration(settingKubeTimeout, &c.KubeTimeout)
}

// applyFlags lets flags override whatever the environment produced, by
// registering each flag with the current value as its default.
func (c *Config) applyFlags(args []string, probs *problems) error {
	fs := flag.NewFlagSet(ComponentName, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.Usage = func() {
		// Writes to the flag set's output are best-effort; a failure to print
		// usage must not change the exit path.
		_, _ = fmt.Fprintf(fs.Output(), "%s — the %s in-cluster agent.\n\n", ComponentName, ProductName)
		_, _ = fmt.Fprintf(fs.Output(), "Every flag has an environment variable equivalent (%s…); flags win.\n\n", EnvPrefix)
		fs.PrintDefaults()
	}

	// Durations, numbers and bools bind directly; the two enum-ish settings go
	// through a string so a bad value becomes a named problem rather than a
	// flag-package error quoting the value.
	logLevel := c.LogLevel.String()

	fs.StringVar(&c.ControlPlaneAddress, settingControlPlaneAddress.flag, c.ControlPlaneAddress,
		"control plane agent gateway to dial out to, host:port or an https:// URL (required)")
	fs.StringVar(&c.ControlPlaneCAFile, settingControlPlaneCAFile.flag, c.ControlPlaneCAFile,
		"PEM CA bundle to pin the control plane to until the agent has enrolled")
	fs.StringVar(&c.ServerName, settingServerName.flag, c.ServerName,
		"TLS server name to verify the gateway against (default: host of the address)")
	fs.StringVar(&c.CredentialsSecret, settingCredentialsSecret.flag, c.CredentialsSecret,
		"Secret in the agent namespace holding the key, certificate and CA")
	fs.StringVar(&c.PolicyConfigMap, settingPolicyConfigMap.flag, c.PolicyConfigMap,
		"ConfigMap holding the agent-side policy, set by the cluster owner")
	fs.StringVar(&c.StateConfigMap, settingStateConfigMap.flag, c.StateConfigMap,
		"ConfigMap the executed-command cache is persisted to")
	fs.StringVar(&c.VeleroNamespace, settingVeleroNamespace.flag, c.VeleroNamespace,
		"namespace Velero runs in")
	fs.StringVar(&c.ClusterID, settingClusterID.flag, c.ClusterID,
		"cluster ID issued by the control plane at enrollment")
	fs.StringVar(&c.ClusterName, settingClusterName.flag, c.ClusterName,
		"human-readable cluster name, used in logs only")
	fs.StringVar(&c.InstanceID, settingInstanceID.flag, c.InstanceID,
		"unique identity of this replica, used for leader election (default: hostname)")
	fs.StringVar(&c.Namespace, settingNamespace.flag, c.Namespace,
		"namespace holding the agent's Lease, Secret and ConfigMap")
	fs.StringVar(&c.KubeconfigPath, settingKubeconfig.flag, c.KubeconfigPath,
		"path to a kubeconfig; only honoured with -"+settingDev.flag)
	fs.BoolVar(&c.Dev, settingDev.flag, c.Dev,
		"run out-of-cluster against a kubeconfig instead of in-cluster credentials")
	fs.StringVar(&c.HealthAddr, settingHealthAddr.flag, c.HealthAddr,
		"bind address for /healthz and /readyz")
	fs.StringVar(&c.MetricsAddr, settingMetricsAddr.flag, c.MetricsAddr,
		"bind address for /metrics; set equal to -"+settingHealthAddr.flag+" to share one listener")
	fs.StringVar(&logLevel, settingLogLevel.flag, logLevel,
		"log level: debug, info, warn or error")
	fs.StringVar(&c.LogFormat, settingLogFormat.flag, c.LogFormat,
		"log format: json, or text with -"+settingDev.flag)
	fs.DurationVar(&c.HeartbeatInterval, settingHeartbeatInterval.flag, c.HeartbeatInterval,
		"interval between heartbeats on the control-plane stream")
	fs.BoolVar(&c.LeaderElection, settingLeaderElection.flag, c.LeaderElection,
		"only the replica holding the Lease connects and executes")
	fs.StringVar(&c.LeaseName, settingLeaseName.flag, c.LeaseName,
		"name of the coordination.k8s.io Lease used for leader election")
	fs.DurationVar(&c.LeaseDuration, settingLeaseDuration.flag, c.LeaseDuration,
		"how long a lease is valid without a renewal")
	fs.DurationVar(&c.LeaseRenewDeadline, settingLeaseRenewDeadline.flag, c.LeaseRenewDeadline,
		"how long the leader retries renewing before giving up")
	fs.DurationVar(&c.LeaseRetryPeriod, settingLeaseRetryPeriod.flag, c.LeaseRetryPeriod,
		"gap between leader-election attempts")
	fs.BoolVar(&c.ReadyRequiresLeadership, settingReadyRequiresLeadership.flag, c.ReadyRequiresLeadership,
		"report /readyz as unavailable on a replica that does not hold the lease")
	fs.DurationVar(&c.ShutdownTimeout, settingShutdownTimeout.flag, c.ShutdownTimeout,
		"deadline for graceful shutdown after SIGTERM or SIGINT")
	fs.Float64Var(&c.KubeQPS, settingKubeQPS.flag, c.KubeQPS,
		"client-side rate limit towards the Kubernetes API, in queries per second")
	fs.IntVar(&c.KubeBurst, settingKubeBurst.flag, c.KubeBurst,
		"client-side burst towards the Kubernetes API")
	fs.DurationVar(&c.KubeTimeout, settingKubeTimeout.flag, c.KubeTimeout,
		"timeout for a single Kubernetes API request")

	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("parse flags: %w", err)
	}
	if fs.NArg() > 0 {
		// The arguments themselves are not echoed: an operator may have pasted
		// a token onto the command line.
		return fmt.Errorf("%w: %d unexpected positional argument(s); this binary takes flags only",
			ErrInvalid, fs.NArg())
	}

	var level slog.Level
	if err := level.UnmarshalText([]byte(strings.TrimSpace(logLevel))); err != nil {
		probs.add(settingLogLevel, "must be one of debug, info, warn, error")
	} else {
		c.LogLevel = level
	}
	c.normalize()
	return nil
}

// normalize trims and lower-cases the settings compared as enums, so that
// "JSON" and " json " behave like "json".
func (c *Config) normalize() {
	c.ControlPlaneAddress = strings.TrimSpace(c.ControlPlaneAddress)
	c.ControlPlaneCAFile = strings.TrimSpace(c.ControlPlaneCAFile)
	c.ServerName = strings.TrimSpace(c.ServerName)
	c.CredentialsSecret = strings.TrimSpace(c.CredentialsSecret)
	c.PolicyConfigMap = strings.TrimSpace(c.PolicyConfigMap)
	c.StateConfigMap = strings.TrimSpace(c.StateConfigMap)
	c.VeleroNamespace = strings.TrimSpace(c.VeleroNamespace)
	c.EnrollmentToken = strings.TrimSpace(c.EnrollmentToken)
	c.ClusterID = strings.ToLower(strings.TrimSpace(c.ClusterID))
	c.InstanceID = strings.TrimSpace(c.InstanceID)
	c.Namespace = strings.TrimSpace(c.Namespace)
	c.KubeconfigPath = strings.TrimSpace(c.KubeconfigPath)
	c.HealthAddr = strings.TrimSpace(c.HealthAddr)
	c.MetricsAddr = strings.TrimSpace(c.MetricsAddr)
	c.LogFormat = strings.ToLower(strings.TrimSpace(c.LogFormat))
	c.LeaseName = strings.TrimSpace(c.LeaseName)
}

// validate records a problem for every setting that cannot be used, rather
// than returning on the first one.
func (c *Config) validate(probs *problems) {
	for _, named := range []struct {
		s setting
		v string
	}{{settingCredentialsSecret, c.CredentialsSecret}, {settingPolicyConfigMap, c.PolicyConfigMap}, {settingStateConfigMap, c.StateConfigMap}} {
		if !dns1123Subdomain.MatchString(named.v) {
			probs.add(named.s, "must be a valid Kubernetes object name")
		}
	}
	if len(c.VeleroNamespace) > 63 || !dns1123Label.MatchString(c.VeleroNamespace) {
		probs.add(settingVeleroNamespace, "must be a valid Kubernetes namespace name")
	}
	if c.ControlPlaneAddress == "" {
		probs.add(settingControlPlaneAddress, "is required: the agent dials out to the control plane (PLAN.md §1.1 P1)")
	} else if reason := checkEndpoint(c.ControlPlaneAddress); reason != "" {
		probs.add(settingControlPlaneAddress, reason)
	}

	if c.ClusterID != "" && !uuidPattern.MatchString(c.ClusterID) {
		probs.add(settingClusterID, "must be the UUID issued by the control plane at enrollment")
	}

	if c.InstanceID == "" {
		probs.add(settingInstanceID, "is required and the hostname could not be read: set it from the pod name via the downward API")
	}

	switch {
	case c.Namespace == "":
		probs.add(settingNamespace, "is required")
	case len(c.Namespace) > 63 || !dns1123Label.MatchString(c.Namespace):
		probs.add(settingNamespace, "must be a DNS-1123 label (lower-case alphanumerics and '-', at most 63 characters)")
	}

	switch {
	case c.LeaseName == "":
		probs.add(settingLeaseName, "is required")
	case len(c.LeaseName) > 253 || !dns1123Subdomain.MatchString(c.LeaseName):
		probs.add(settingLeaseName, "must be a DNS-1123 subdomain (a valid Kubernetes object name)")
	}

	if c.KubeconfigPath != "" && !c.Dev {
		probs.add(settingKubeconfig, "is only honoured together with -"+settingDev.flag+"; in-cluster credentials are used otherwise")
	}

	if reason := checkBindAddr(c.HealthAddr); reason != "" {
		probs.add(settingHealthAddr, reason)
	}
	if reason := checkBindAddr(c.MetricsAddr); reason != "" {
		probs.add(settingMetricsAddr, reason)
	}

	switch c.LogFormat {
	case LogFormatJSON:
	case LogFormatText:
		if !c.Dev {
			probs.add(settingLogFormat, "may only be \""+LogFormatText+"\" together with -"+settingDev.flag+
				"; PLAN.md §4.1 requires JSON logs")
		}
	default:
		probs.add(settingLogFormat, "must be \""+LogFormatJSON+"\" or \""+LogFormatText+"\"")
	}

	if c.HeartbeatInterval < time.Second {
		probs.add(settingHeartbeatInterval, "must be at least 1s")
	}
	if c.ShutdownTimeout < time.Second {
		probs.add(settingShutdownTimeout, "must be at least 1s")
	}
	if c.KubeTimeout < time.Second {
		probs.add(settingKubeTimeout, "must be at least 1s")
	}
	if c.KubeQPS <= 0 {
		probs.add(settingKubeQPS, "must be greater than zero")
	}
	if c.KubeBurst <= 0 {
		probs.add(settingKubeBurst, "must be greater than zero")
	}

	if c.LeaderElection {
		c.validateLeaseTimings(probs)
	}
}

// validateLeaseTimings mirrors the constraints client-go's leader elector
// enforces, so a bad combination is named at startup instead of surfacing as
// an opaque error once the election begins (PLAN.md §3.2).
func (c *Config) validateLeaseTimings(probs *problems) {
	if c.LeaseRetryPeriod <= 0 {
		probs.add(settingLeaseRetryPeriod, "must be greater than zero")
	}
	if c.LeaseRenewDeadline <= 0 {
		probs.add(settingLeaseRenewDeadline, "must be greater than zero")
	}
	if c.LeaseDuration <= 0 {
		probs.add(settingLeaseDuration, "must be greater than zero")
	}
	if c.LeaseDuration > 0 && c.LeaseRenewDeadline > 0 && c.LeaseDuration <= c.LeaseRenewDeadline {
		probs.add(settingLeaseDuration, "must be greater than -"+settingLeaseRenewDeadline.flag)
	}
	if c.LeaseRenewDeadline > 0 && c.LeaseRetryPeriod > 0 &&
		c.LeaseRenewDeadline <= time.Duration(leaseJitterFactor*float64(c.LeaseRetryPeriod)) {
		probs.add(settingLeaseRenewDeadline, fmt.Sprintf("must be greater than -%s multiplied by %.1f",
			settingLeaseRetryPeriod.flag, leaseJitterFactor))
	}
}

// checkEndpoint returns an empty string when addr is usable, or a reason that
// never contains addr itself.
func checkEndpoint(addr string) string {
	if strings.Contains(addr, "://") {
		parsed, err := url.Parse(addr)
		if err != nil {
			return "is not a valid URL"
		}
		if parsed.Scheme != "https" {
			return "must use the https scheme: TLS towards the control plane is mandatory (PLAN.md §12.1)"
		}
		if parsed.Host == "" {
			return "is missing a host"
		}
		if parsed.User != nil {
			return "must not embed credentials in the URL"
		}
		if _, port, err := net.SplitHostPort(parsed.Host); err == nil {
			if reason := checkPort(port); reason != "" {
				return reason
			}
		}
		return ""
	}

	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "must be host:port or an https:// URL"
	}
	if host == "" {
		return "is missing a host"
	}
	return checkPort(port)
}

// checkBindAddr validates a listen address such as ":8081" or "127.0.0.1:9090".
func checkBindAddr(addr string) string {
	if addr == "" {
		return "is required"
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "must be a bind address such as \":8081\""
	}
	return checkPort(port)
}

func checkPort(port string) string {
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return "has an invalid port"
	}
	return ""
}

// LogValue implements slog.LogValuer so that logging a Config cannot spill a
// value that might be sensitive (PLAN.md §12.1). Every attribute below is
// either a bounded enum, a number, an identifier issued by the control plane,
// or a value stripped by [sanitizeEndpoint]. Anything else is reported as
// presence only.
func (c *Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("control_plane_address", sanitizeEndpoint(c.ControlPlaneAddress)),
		slog.Bool("control_plane_ca_file_set", c.ControlPlaneCAFile != ""),
		slog.String("server_name", c.ServerName),
		slog.String("credentials_secret", c.CredentialsSecret),
		slog.String("policy_configmap", c.PolicyConfigMap),
		slog.String("state_configmap", c.StateConfigMap),
		slog.String("velero_namespace", c.VeleroNamespace),
		// Presence only: the token is a credential.
		slog.Bool("enrollment_token_set", c.EnrollmentToken != ""),
		slog.String("cluster_id", c.ClusterID),
		slog.String("cluster_name", c.ClusterName),
		slog.String("instance_id", c.InstanceID),
		slog.String("namespace", c.Namespace),
		// The path itself is withheld: in dev it often points inside a home
		// directory at a file holding embedded credentials.
		slog.Bool("kubeconfig_set", c.KubeconfigPath != ""),
		slog.Bool("dev", c.Dev),
		slog.String("health_addr", c.HealthAddr),
		slog.String("metrics_addr", c.MetricsAddr),
		slog.String("log_level", c.LogLevel.String()),
		slog.String("log_format", c.LogFormat),
		slog.String("heartbeat_interval", c.HeartbeatInterval.String()),
		slog.Bool("leader_election", c.LeaderElection),
		slog.String("lease_name", c.LeaseName),
		slog.String("lease_duration", c.LeaseDuration.String()),
		slog.String("lease_renew_deadline", c.LeaseRenewDeadline.String()),
		slog.String("lease_retry_period", c.LeaseRetryPeriod.String()),
		slog.Bool("ready_requires_leadership", c.ReadyRequiresLeadership),
		slog.String("shutdown_timeout", c.ShutdownTimeout.String()),
		slog.Float64("kube_qps", c.KubeQPS),
		slog.Int("kube_burst", c.KubeBurst),
		slog.String("kube_timeout", c.KubeTimeout.String()),
	)
}

// sanitizeEndpoint reduces an address to the parts that are safe to log: the
// scheme, host and port. Userinfo, path, query and fragment are dropped
// because a URL may carry credentials or a bootstrap token (PLAN.md §12.1).
func sanitizeEndpoint(addr string) string {
	if addr == "" {
		return ""
	}
	if !strings.Contains(addr, "://") {
		// A bare host:port carries nothing to strip.
		return addr
	}
	parsed, err := url.Parse(addr)
	if err != nil || parsed.Host == "" {
		return redactedValue
	}
	return parsed.Scheme + "://" + parsed.Host
}

// UserAgent is the User-Agent this agent presents to the Kubernetes API.
func (c *Config) UserAgent(version string) string {
	return ComponentName + "/" + version
}

// ErrInvalid is wrapped by every configuration rejection, so callers can test
// with errors.Is.
var ErrInvalid = errors.New("invalid configuration")

// Problem is one rejected setting. It records names and a reason only — never
// the offending value, which may be a credential (PLAN.md §12.1).
type Problem struct {
	Env    string
	Flag   string
	Reason string
}

// String renders the problem as "VFM_X (-x): reason".
func (p Problem) String() string {
	return fmt.Sprintf("%s (-%s): %s", p.Env, p.Flag, p.Reason)
}

// Error aggregates every rejected setting from one [Load].
type Error struct {
	Problems []Problem
}

// Error lists every offending setting by name.
func (e *Error) Error() string {
	parts := make([]string, 0, len(e.Problems))
	for _, p := range e.Problems {
		parts = append(parts, p.String())
	}
	return ErrInvalid.Error() + ": " + strings.Join(parts, "; ")
}

// Unwrap makes errors.Is(err, ErrInvalid) true.
func (e *Error) Unwrap() error { return ErrInvalid }

// problems collects rejected settings during a single Load.
type problems struct {
	list []Problem
}

func (p *problems) add(s setting, reason string) {
	p.list = append(p.list, Problem{Env: s.env, Flag: s.flag, Reason: reason})
}

func (p *problems) err() error {
	if len(p.list) == 0 {
		return nil
	}
	return &Error{Problems: p.list}
}

// envReader applies environment variables, recording a problem for anything
// that does not parse. The underlying parse errors are discarded on purpose:
// they quote the offending value (PLAN.md §12.1).
type envReader struct {
	getenv func(string) (string, bool)
	probs  *problems
}

func (r envReader) str(s setting, dst *string) {
	if value, ok := r.getenv(s.env); ok {
		*dst = strings.TrimSpace(value)
	}
}

func (r envReader) boolean(s setting, dst *bool) {
	value, ok := r.getenv(s.env)
	if !ok {
		return
	}
	parsed, err := strconv.ParseBool(strings.TrimSpace(value))
	if err != nil {
		r.probs.add(s, "must be a boolean: true or false")
		return
	}
	*dst = parsed
}

func (r envReader) duration(s setting, dst *time.Duration) {
	value, ok := r.getenv(s.env)
	if !ok {
		return
	}
	parsed, err := time.ParseDuration(strings.TrimSpace(value))
	if err != nil {
		r.probs.add(s, "must be a duration such as \"15s\" or \"2m\"")
		return
	}
	*dst = parsed
}

func (r envReader) integer(s setting, dst *int) {
	value, ok := r.getenv(s.env)
	if !ok {
		return
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		r.probs.add(s, "must be an integer")
		return
	}
	*dst = parsed
}

func (r envReader) float(s setting, dst *float64) {
	value, ok := r.getenv(s.env)
	if !ok {
		return
	}
	parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		r.probs.add(s, "must be a number")
		return
	}
	*dst = parsed
}

func (r envReader) level(s setting, dst *slog.Level) {
	value, ok := r.getenv(s.env)
	if !ok {
		return
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(strings.TrimSpace(value))); err != nil {
		r.probs.add(s, "must be one of debug, info, warn, error")
		return
	}
	*dst = level
}
