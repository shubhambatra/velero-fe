package config

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// envOf turns a map into the lookup function Load expects. A key present with
// an empty value is reported as set, which is how "explicitly cleared" is
// distinguished from "absent".
func envOf(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

// minimalEnv is the smallest environment that loads successfully: the control
// plane address is the only required setting, and the instance ID is pinned so
// tests do not depend on the hostname.
func minimalEnv() map[string]string {
	return map[string]string{
		EnvControlPlaneAddress: "cp.example.com:8443",
		EnvInstanceID:          "vfm-agent-0",
	}
}

// offendingSettings lists the environment variables named by err.
func offendingSettings(tb testing.TB, err error) []string {
	tb.Helper()
	if err == nil {
		tb.Fatal("expected a configuration error, got nil")
	}
	if !errors.Is(err, ErrInvalid) {
		tb.Fatalf("error does not wrap ErrInvalid: %v", err)
	}
	var cfgErr *Error
	if !errors.As(err, &cfgErr) {
		tb.Fatalf("error is not a *config.Error: %v", err)
	}
	keys := make([]string, 0, len(cfgErr.Problems))
	for _, problem := range cfgErr.Problems {
		keys = append(keys, problem.Env)
	}
	return keys
}

func namesSetting(keys []string, want string) bool {
	for _, key := range keys {
		if key == want {
			return true
		}
	}
	return false
}

func TestLoadAppliesDefaults(t *testing.T) {
	cfg, err := Load(nil, envOf(minimalEnv()))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	want := Default()
	want.ControlPlaneAddress = "cp.example.com:8443"
	want.InstanceID = "vfm-agent-0"

	if *cfg != *want {
		t.Errorf("unexpected configuration\n got: %+v\nwant: %+v", *cfg, *want)
	}
	if cfg.Namespace != AgentNamespace {
		t.Errorf("Namespace = %q, want %q", cfg.Namespace, AgentNamespace)
	}
	if cfg.HeartbeatInterval != 15*time.Second {
		t.Errorf("HeartbeatInterval = %s, want 15s (PLAN.md §5.2)", cfg.HeartbeatInterval)
	}
	if !cfg.LeaderElection {
		t.Error("LeaderElection = false, want true (PLAN.md §3.2)")
	}
	if cfg.LogFormat != LogFormatJSON {
		t.Errorf("LogFormat = %q, want %q (PLAN.md §4.1)", cfg.LogFormat, LogFormatJSON)
	}
}

func TestLoadFromEnvironment(t *testing.T) {
	cfg, err := Load(nil, envOf(map[string]string{
		EnvControlPlaneAddress:     "https://cp.example.com:8443",
		EnvControlPlaneCAFile:      "/etc/vfm/ca.pem",
		EnvServerName:              "gateway.internal",
		EnvCredentialsSecret:       "my-creds",
		EnvPolicyConfigMap:         "my-policy",
		EnvStateConfigMap:          "my-state",
		EnvVeleroNamespace:         "backup-system",
		EnvEnrollmentToken:         "tok-from-chart",
		EnvClusterID:               "018f3b2c-7e4a-7c3d-9b1e-2a4c6e8f0a12",
		EnvClusterName:             "prod-eu-1",
		EnvInstanceID:              "vfm-agent-0",
		EnvNamespace:               "vfm-system",
		EnvKubeconfig:              "/home/dev/.kube/config",
		EnvDev:                     "true",
		EnvHealthAddr:              "127.0.0.1:18081",
		EnvMetricsAddr:             "127.0.0.1:19090",
		EnvLogLevel:                "debug",
		EnvLogFormat:               "text",
		EnvHeartbeatInterval:       "30s",
		EnvLeaderElection:          "false",
		EnvLeaseName:               "custom-agent-lease",
		EnvLeaseDuration:           "20s",
		EnvLeaseRenewDeadline:      "12s",
		EnvLeaseRetryPeriod:        "3s",
		EnvReadyRequiresLeadership: "true",
		EnvShutdownTimeout:         "25s",
		EnvKubeQPS:                 "40.5",
		EnvKubeBurst:               "60",
		EnvKubeTimeout:             "15s",
	}))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	want := Config{
		ControlPlaneAddress:     "https://cp.example.com:8443",
		ControlPlaneCAFile:      "/etc/vfm/ca.pem",
		ServerName:              "gateway.internal",
		CredentialsSecret:       "my-creds",
		PolicyConfigMap:         "my-policy",
		StateConfigMap:          "my-state",
		VeleroNamespace:         "backup-system",
		EnrollmentToken:         "tok-from-chart",
		ClusterID:               "018f3b2c-7e4a-7c3d-9b1e-2a4c6e8f0a12",
		ClusterName:             "prod-eu-1",
		InstanceID:              "vfm-agent-0",
		Namespace:               "vfm-system",
		KubeconfigPath:          "/home/dev/.kube/config",
		Dev:                     true,
		HealthAddr:              "127.0.0.1:18081",
		MetricsAddr:             "127.0.0.1:19090",
		LogLevel:                slog.LevelDebug,
		LogFormat:               LogFormatText,
		HeartbeatInterval:       30 * time.Second,
		LeaderElection:          false,
		LeaseName:               "custom-agent-lease",
		LeaseDuration:           20 * time.Second,
		LeaseRenewDeadline:      12 * time.Second,
		LeaseRetryPeriod:        3 * time.Second,
		ReadyRequiresLeadership: true,
		ShutdownTimeout:         25 * time.Second,
		KubeQPS:                 40.5,
		KubeBurst:               60,
		KubeTimeout:             15 * time.Second,
	}
	if *cfg != want {
		t.Errorf("unexpected configuration\n got: %+v\nwant: %+v", *cfg, want)
	}
}

func TestLoadNormalizesEnumsAndWhitespace(t *testing.T) {
	env := minimalEnv()
	env[EnvLogFormat] = "  JSON  "
	env[EnvLogLevel] = "WARN"
	env[EnvNamespace] = " vfm-system "
	env[EnvClusterID] = "018F3B2C-7E4A-7C3D-9B1E-2A4C6E8F0A12"

	cfg, err := Load(nil, envOf(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.LogFormat != LogFormatJSON {
		t.Errorf("LogFormat = %q, want %q", cfg.LogFormat, LogFormatJSON)
	}
	if cfg.LogLevel != slog.LevelWarn {
		t.Errorf("LogLevel = %s, want WARN", cfg.LogLevel)
	}
	if cfg.Namespace != "vfm-system" {
		t.Errorf("Namespace = %q, want %q", cfg.Namespace, "vfm-system")
	}
	if cfg.ClusterID != "018f3b2c-7e4a-7c3d-9b1e-2a4c6e8f0a12" {
		t.Errorf("ClusterID = %q, want it lower-cased", cfg.ClusterID)
	}
}

func TestFlagsOverrideEnvironment(t *testing.T) {
	env := map[string]string{
		EnvControlPlaneAddress: "env.example.com:8443",
		EnvInstanceID:          "from-env",
		EnvNamespace:           "env-namespace",
		EnvLogLevel:            "error",
		EnvHeartbeatInterval:   "60s",
		EnvLeaderElection:      "true",
		EnvKubeBurst:           "11",
	}
	args := []string{
		"-control-plane-address=flag.example.com:9443",
		"-instance-id=from-flag",
		"-namespace=flag-namespace",
		"-log-level=debug",
		"-heartbeat-interval=5s",
		"-leader-election=false",
		"-kube-burst=22",
	}

	cfg, err := Load(args, envOf(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	checks := []struct {
		name string
		got  any
		want any
	}{
		{"ControlPlaneAddress", cfg.ControlPlaneAddress, "flag.example.com:9443"},
		{"InstanceID", cfg.InstanceID, "from-flag"},
		{"Namespace", cfg.Namespace, "flag-namespace"},
		{"LogLevel", cfg.LogLevel, slog.LevelDebug},
		{"HeartbeatInterval", cfg.HeartbeatInterval, 5 * time.Second},
		{"LeaderElection", cfg.LeaderElection, false},
		{"KubeBurst", cfg.KubeBurst, 22},
	}
	for _, check := range checks {
		if check.got != check.want {
			t.Errorf("%s = %v, want the flag value %v", check.name, check.got, check.want)
		}
	}
}

func TestEnvironmentAppliesWhereNoFlagIsGiven(t *testing.T) {
	env := minimalEnv()
	env[EnvLogLevel] = "warn"

	cfg, err := Load([]string{"-namespace=flag-namespace"}, envOf(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.LogLevel != slog.LevelWarn {
		t.Errorf("LogLevel = %s, want WARN from the environment", cfg.LogLevel)
	}
	if cfg.Namespace != "flag-namespace" {
		t.Errorf("Namespace = %q, want the flag value", cfg.Namespace)
	}
}

func TestLoadRejectsMissingRequiredSettings(t *testing.T) {
	// No control plane address at all, and an instance ID explicitly cleared.
	keys := offendingSettings(t, mustFailLoad(t, nil, map[string]string{EnvInstanceID: ""}))

	for _, want := range []string{EnvControlPlaneAddress, EnvInstanceID} {
		if !namesSetting(keys, want) {
			t.Errorf("error does not name %s; named %v", want, keys)
		}
	}
}

func TestLoadRejectsMalformedValues(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		args    []string
		wantKey string
	}{
		{
			name:    "control plane address without a port",
			env:     map[string]string{EnvControlPlaneAddress: "cp.example.com"},
			wantKey: EnvControlPlaneAddress,
		},
		{
			name:    "control plane address with a plaintext scheme",
			env:     map[string]string{EnvControlPlaneAddress: "http://cp.example.com:8443"},
			wantKey: EnvControlPlaneAddress,
		},
		{
			name:    "control plane address with embedded credentials",
			env:     map[string]string{EnvControlPlaneAddress: "https://user:pw@cp.example.com:8443"}, //nolint:gosec // fixture: proves userinfo is rejected
			wantKey: EnvControlPlaneAddress,
		},
		{
			name:    "control plane port out of range",
			env:     map[string]string{EnvControlPlaneAddress: "cp.example.com:70000"},
			wantKey: EnvControlPlaneAddress,
		},
		{
			name:    "cluster id that is not a uuid",
			env:     map[string]string{EnvClusterID: "cluster-one"},
			wantKey: EnvClusterID,
		},
		{
			name:    "namespace that is not a dns label",
			env:     map[string]string{EnvNamespace: "VFM_System"},
			wantKey: EnvNamespace,
		},
		{
			name:    "empty namespace",
			env:     map[string]string{EnvNamespace: ""},
			wantKey: EnvNamespace,
		},
		{
			name:    "lease name that is not a kubernetes object name",
			env:     map[string]string{EnvLeaseName: "Agent Lease"},
			wantKey: EnvLeaseName,
		},
		{
			name:    "kubeconfig without dev mode",
			env:     map[string]string{EnvKubeconfig: "/home/dev/.kube/config"},
			wantKey: EnvKubeconfig,
		},
		{
			name:    "health address without a port",
			env:     map[string]string{EnvHealthAddr: "8081"},
			wantKey: EnvHealthAddr,
		},
		{
			name:    "metrics address with a non-numeric port",
			env:     map[string]string{EnvMetricsAddr: ":metrics"},
			wantKey: EnvMetricsAddr,
		},
		{
			name:    "unparseable duration",
			env:     map[string]string{EnvHeartbeatInterval: "15"},
			wantKey: EnvHeartbeatInterval,
		},
		{
			name:    "heartbeat interval below the floor",
			env:     map[string]string{EnvHeartbeatInterval: "100ms"},
			wantKey: EnvHeartbeatInterval,
		},
		{
			name:    "unparseable boolean",
			env:     map[string]string{EnvLeaderElection: "yes-please"},
			wantKey: EnvLeaderElection,
		},
		{
			name:    "unparseable integer",
			env:     map[string]string{EnvKubeBurst: "thirty"},
			wantKey: EnvKubeBurst,
		},
		{
			name:    "non-positive integer",
			env:     map[string]string{EnvKubeBurst: "0"},
			wantKey: EnvKubeBurst,
		},
		{
			name:    "unparseable float",
			env:     map[string]string{EnvKubeQPS: "fast"},
			wantKey: EnvKubeQPS,
		},
		{
			name:    "unknown log level",
			env:     map[string]string{EnvLogLevel: "verbose"},
			wantKey: EnvLogLevel,
		},
		{
			name:    "unknown log level from a flag",
			args:    []string{"-log-level=verbose"},
			wantKey: EnvLogLevel,
		},
		{
			name:    "unknown log format",
			env:     map[string]string{EnvLogFormat: "logfmt"},
			wantKey: EnvLogFormat,
		},
		{
			name:    "shutdown timeout below the floor",
			env:     map[string]string{EnvShutdownTimeout: "0s"},
			wantKey: EnvShutdownTimeout,
		},
		{
			name:    "kube timeout below the floor",
			env:     map[string]string{EnvKubeTimeout: "0s"},
			wantKey: EnvKubeTimeout,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			keys := offendingSettings(t, mustFailLoad(t, test.args, test.env))
			if !namesSetting(keys, test.wantKey) {
				t.Errorf("error does not name %s; named %v", test.wantKey, keys)
			}
		})
	}
}

// TestLeaseTimingValidation covers the constraints client-go's leader elector
// enforces, which the agent checks at startup instead (PLAN.md §3.2).
func TestLeaseTimingValidation(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantKey string // empty means the combination must be accepted
	}{
		{
			name: "defaults are accepted",
		},
		{
			name: "custom but consistent timings are accepted",
			env:  map[string]string{EnvLeaseDuration: "30s", EnvLeaseRenewDeadline: "20s", EnvLeaseRetryPeriod: "4s"},
		},
		{
			name:    "lease duration not greater than the renew deadline",
			env:     map[string]string{EnvLeaseDuration: "10s", EnvLeaseRenewDeadline: "10s"},
			wantKey: EnvLeaseDuration,
		},
		{
			name:    "renew deadline within the jittered retry period",
			env:     map[string]string{EnvLeaseDuration: "15s", EnvLeaseRenewDeadline: "6s", EnvLeaseRetryPeriod: "5s"},
			wantKey: EnvLeaseRenewDeadline,
		},
		{
			name:    "zero retry period",
			env:     map[string]string{EnvLeaseRetryPeriod: "0s"},
			wantKey: EnvLeaseRetryPeriod,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			env := minimalEnv()
			for key, value := range test.env {
				env[key] = value
			}

			cfg, err := Load(nil, envOf(env))
			if test.wantKey == "" {
				if err != nil {
					t.Fatalf("Load: %v", err)
				}
				if cfg == nil {
					t.Fatal("Load returned no configuration")
				}
				return
			}
			keys := offendingSettings(t, err)
			if !namesSetting(keys, test.wantKey) {
				t.Errorf("error does not name %s; named %v", test.wantKey, keys)
			}
		})
	}
}

// TestLeaseTimingsIgnoredWhenElectionDisabled documents that a dev run with
// leader election off is not blocked by lease timings it will never use.
func TestLeaseTimingsIgnoredWhenElectionDisabled(t *testing.T) {
	env := minimalEnv()
	env[EnvLeaderElection] = "false"
	env[EnvLeaseDuration] = "1s"
	env[EnvLeaseRenewDeadline] = "5s"

	if _, err := Load(nil, envOf(env)); err != nil {
		t.Fatalf("Load: %v", err)
	}
}

func TestTextLogFormatRequiresDevMode(t *testing.T) {
	env := minimalEnv()
	env[EnvLogFormat] = LogFormatText

	keys := offendingSettings(t, mustFailLoad(t, nil, env))
	if !namesSetting(keys, EnvLogFormat) {
		t.Errorf("error does not name %s; named %v", EnvLogFormat, keys)
	}

	env[EnvDev] = "true"
	if _, err := Load(nil, envOf(env)); err != nil {
		t.Fatalf("text format with -dev should be accepted: %v", err)
	}
}

func TestLoadReportsEveryProblemAtOnce(t *testing.T) {
	err := mustFailLoad(t, nil, map[string]string{
		EnvNamespace:         "Not A Label",
		EnvHeartbeatInterval: "nope",
		EnvKubeBurst:         "-1",
	})

	keys := offendingSettings(t, err)
	for _, want := range []string{EnvControlPlaneAddress, EnvNamespace, EnvHeartbeatInterval, EnvKubeBurst} {
		if !namesSetting(keys, want) {
			t.Errorf("error does not name %s; named %v", want, keys)
		}
	}
	if len(keys) < 4 {
		t.Errorf("expected at least 4 problems, got %d: %v", len(keys), keys)
	}
}

func TestLoadRejectsPositionalArguments(t *testing.T) {
	const positional = "s3cret-positional-argument"

	err := mustFailLoad(t, []string{positional}, minimalEnv())
	if !errors.Is(err, ErrInvalid) {
		t.Errorf("error does not wrap ErrInvalid: %v", err)
	}
	// An operator may have pasted a token onto the command line.
	if strings.Contains(err.Error(), positional) {
		t.Errorf("the rejected argument must not be echoed: %s", err)
	}
}

// TestLoadErrorNeverEchoesValues is the safe-logging guarantee for startup
// failures: a bad value may be a credential (PLAN.md §12.1).
func TestLoadErrorNeverEchoesValues(t *testing.T) {
	const (
		secretInURL   = "s3cr3t-password"
		secretInToken = "bootstrap-t0ken"
	)
	err := mustFailLoad(t, nil, map[string]string{
		EnvControlPlaneAddress: "http://agent:" + secretInURL + "@cp.example.com:8443/connect?token=" + secretInToken,
		EnvHeartbeatInterval:   secretInToken,
		EnvKubeQPS:             secretInURL,
	})

	message := err.Error()
	for _, forbidden := range []string{secretInURL, secretInToken} {
		if strings.Contains(message, forbidden) {
			t.Errorf("error message leaks a configured value %q: %s", forbidden, message)
		}
	}
	for _, want := range []string{EnvControlPlaneAddress, EnvHeartbeatInterval, EnvKubeQPS} {
		if !strings.Contains(message, want) {
			t.Errorf("error message does not name %s: %s", want, message)
		}
	}
}

// TestLogValueRedacts is the safe-logging guarantee for the running agent.
func TestLogValueRedacts(t *testing.T) {
	const (
		userinfoSecret = "s3cr3t-password"
		querySecret    = "bootstrap-t0ken"
		kubeconfigPath = "/home/alice/.kube/config"
	)
	cfg := Default()
	cfg.ControlPlaneAddress = "https://agent:" + userinfoSecret + "@cp.example.com:8443/connect?token=" + querySecret
	cfg.KubeconfigPath = kubeconfigPath
	cfg.InstanceID = "vfm-agent-0"
	cfg.EnrollmentToken = "enrol-t0ken-must-not-log"

	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("starting", "config", cfg)
	logged := buf.String()

	for _, forbidden := range []string{userinfoSecret, querySecret, kubeconfigPath, cfg.EnrollmentToken} {
		if strings.Contains(logged, forbidden) {
			t.Errorf("log line leaks %q: %s", forbidden, logged)
		}
	}
	if !strings.Contains(logged, "cp.example.com:8443") {
		t.Errorf("log line should keep the control plane host for diagnostics: %s", logged)
	}
	if !strings.Contains(logged, "kubeconfig_set") {
		t.Errorf("log line should report kubeconfig presence: %s", logged)
	}
}

func TestSanitizeEndpoint(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "empty", input: "", want: ""},
		{name: "host and port are kept as-is", input: "cp.example.com:8443", want: "cp.example.com:8443"},
		{name: "scheme host and port are kept", input: "https://cp.example.com:8443", want: "https://cp.example.com:8443"},
		{name: "userinfo is dropped", input: "https://user:pw@cp.example.com:8443", want: "https://cp.example.com:8443"}, //nolint:gosec // fixture: proves userinfo is stripped
		{name: "path and query are dropped", input: "https://cp.example.com:8443/connect?token=abc", want: "https://cp.example.com:8443"},
		{name: "unparseable input is redacted", input: "https://%zz", want: redactedValue},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := sanitizeEndpoint(test.input); got != test.want {
				t.Errorf("sanitizeEndpoint(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestProblemStringNamesBothSpellings(t *testing.T) {
	problem := Problem{Env: EnvControlPlaneAddress, Flag: "control-plane-address", Reason: "is required"}
	got := problem.String()
	for _, want := range []string{EnvControlPlaneAddress, "-control-plane-address", "is required"} {
		if !strings.Contains(got, want) {
			t.Errorf("Problem.String() = %q, want it to contain %q", got, want)
		}
	}
}

func TestUserAgentIdentifiesTheAgent(t *testing.T) {
	got := Default().UserAgent("1.2.3")
	if got != ComponentName+"/1.2.3" {
		t.Errorf("UserAgent = %q, want %q", got, ComponentName+"/1.2.3")
	}
}

// mustFailLoad asserts that Load rejects the given input and returns the error.
func mustFailLoad(tb testing.TB, args []string, env map[string]string) error {
	tb.Helper()
	if env == nil {
		env = map[string]string{}
	}
	if _, ok := env[EnvInstanceID]; !ok {
		env[EnvInstanceID] = "vfm-agent-0"
	}
	cfg, err := Load(args, envOf(env))
	if err == nil {
		tb.Fatalf("Load unexpectedly succeeded: %+v", cfg)
	}
	return err
}

func TestEnrollmentTokenIsEnvironmentOnly(t *testing.T) {
	// A flag would put the token in the process list; there must not be one.
	_, err := Load([]string{"-enrollment-token=abc"}, envOf(map[string]string{
		EnvControlPlaneAddress: "cp.example.com:8443",
	}))
	if err == nil {
		t.Fatal("an -enrollment-token flag was accepted")
	}
}

func TestCredentialsSecretMustBeAValidName(t *testing.T) {
	_, err := Load(nil, envOf(map[string]string{
		EnvControlPlaneAddress: "cp.example.com:8443",
		EnvCredentialsSecret:   "Not A Name",
	}))
	if err == nil || !strings.Contains(err.Error(), EnvCredentialsSecret) {
		t.Fatalf("want a problem naming %s, got %v", EnvCredentialsSecret, err)
	}
}
