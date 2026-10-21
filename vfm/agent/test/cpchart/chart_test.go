// Package cpchart_test renders the control-plane Helm chart and checks it against PLAN.md and against the
// server it deploys (threat model G-1: container hardening of the component that holds the keys).
//
// It needs the `helm` binary. In CI it is always present and VFM_REQUIRE_HELM=1 makes a missing helm a failure
// instead of a skip.
// NOTE: run with -count=1 (the Makefile and CI do). Go's test cache cannot see the chart, which is outside
// the Go module, so a changed chart would otherwise be answered from the cache.
package cpchart_test

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/util/yaml"
	sigsyaml "sigs.k8s.io/yaml"
)

const (
	chartDir   = "../../../deploy/helm/vfm-control-plane"
	obsDir     = "../../../deploy/observability"
	envSchema  = "../../../server/src/config/env.schema.ts"
	release    = "vfm"
	namespace  = "vfm-system"
	secretName = "vfm-secrets"
)

var required = []string{"--set", "secrets.existingSecret=" + secretName, "--set", "gateway.publicAddress=agents.example.com:8443"}

func helm(t *testing.T, args ...string) (string, error) {
	t.Helper()
	bin, err := exec.LookPath("helm")
	if err != nil {
		if os.Getenv("VFM_REQUIRE_HELM") != "" {
			t.Fatal("helm is required (VFM_REQUIRE_HELM is set) but was not found")
		}
		t.Skip("helm not installed; the chart tests are skipped")
	}
	cmd := exec.Command(bin, args...) //nolint:gosec // fixed binary, test-controlled arguments
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w: %s", err, errb.String())
	}
	return out.String(), nil
}

func render(t *testing.T, extra ...string) string {
	t.Helper()
	args := append([]string{"template", release, chartDir, "--namespace", namespace}, required...)
	out, err := helm(t, append(args, extra...)...)
	if err != nil {
		t.Fatalf("helm template: %v", err)
	}
	return out
}

// docs splits rendered output into raw documents by kind.
func docs(t *testing.T, rendered string) map[string][][]byte {
	t.Helper()
	out := map[string][][]byte{}
	dec := yaml.NewYAMLOrJSONDecoder(strings.NewReader(rendered), 4096)
	for {
		var raw map[string]any
		if err := dec.Decode(&raw); err != nil {
			if err.Error() == "EOF" {
				return out
			}
			t.Fatalf("decode: %v", err)
		}
		if raw == nil {
			continue
		}
		kind, _ := raw["kind"].(string)
		b, err := sigsyaml.Marshal(raw)
		if err != nil {
			t.Fatal(err)
		}
		out[kind] = append(out[kind], b)
	}
}

func one[T any](t *testing.T, d map[string][][]byte, kind string) T {
	t.Helper()
	var v T
	if len(d[kind]) != 1 {
		t.Fatalf("want exactly one %s, got %d", kind, len(d[kind]))
	}
	if err := sigsyaml.Unmarshal(d[kind][0], &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestTheChartRefusesToInstallWithoutTheThingsItCannotWorkWithout(t *testing.T) {
	base := []string{"template", release, chartDir, "--namespace", namespace}
	if _, err := helm(t, append(base, "--set", "gateway.publicAddress=a:8443")...); err == nil || !strings.Contains(err.Error(), "secrets.existingSecret") {
		t.Fatalf("want a refusal naming secrets.existingSecret, got %v", err)
	}
	if _, err := helm(t, append(base, "--set", "secrets.existingSecret=x")...); err == nil || !strings.Contains(err.Error(), "gateway.publicAddress") {
		t.Fatalf("want a refusal naming gateway.publicAddress, got %v", err)
	}
	if _, err := helm(t, append(append(base, required...), "--set", "ingress.enabled=true")...); err == nil || !strings.Contains(err.Error(), "ingress.host") {
		t.Fatalf("want a refusal naming ingress.host, got %v", err)
	}
}

func TestTheDeploymentIsHardened(t *testing.T) {
	d := one[appsv1.Deployment](t, docs(t, render(t)), "Deployment")
	pod := d.Spec.Template.Spec
	if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
		t.Error("the control plane must not mount a service account token (it never talks to the Kubernetes API)")
	}
	psc := pod.SecurityContext
	if psc == nil || psc.RunAsNonRoot == nil || !*psc.RunAsNonRoot || psc.SeccompProfile == nil || psc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Errorf("pod security context is not non-root + RuntimeDefault seccomp: %+v", psc)
	}
	if pod.HostNetwork || pod.HostPID || pod.HostIPC {
		t.Error("host namespaces must not be shared")
	}
	if len(pod.Containers) != 1 {
		t.Fatalf("want one container, got %d", len(pod.Containers))
	}
	c := pod.Containers[0]
	sc := c.SecurityContext
	if sc == nil || sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem {
		t.Error("the root filesystem must be read-only")
	}
	if sc == nil || sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Error("privilege escalation must be off")
	}
	if sc == nil || sc.Privileged != nil && *sc.Privileged {
		t.Error("must not be privileged")
	}
	if sc == nil || sc.Capabilities == nil || len(sc.Capabilities.Drop) != 1 || sc.Capabilities.Drop[0] != "ALL" || len(sc.Capabilities.Add) != 0 {
		t.Errorf("must drop ALL capabilities and add none: %+v", sc)
	}
	if c.Resources.Requests.Cpu().IsZero() || c.Resources.Limits.Memory().IsZero() {
		t.Error("requests and a memory limit are required")
	}
	// A database outage must not restart every replica.
	if c.LivenessProbe == nil || c.LivenessProbe.HTTPGet == nil || c.LivenessProbe.HTTPGet.Path != "/healthz" {
		t.Error("liveness must be /healthz, which touches no dependency")
	}
	if c.ReadinessProbe == nil || c.ReadinessProbe.HTTPGet == nil || c.ReadinessProbe.HTTPGet.Path != "/readyz" {
		t.Error("readiness must be /readyz")
	}
	if got := strings.Join(imagePorts(c), ","); got != "grpc:8443,http:3000,metrics:9090" {
		t.Errorf("ports = %s", got)
	}
	if d.Spec.Strategy.RollingUpdate == nil || d.Spec.Strategy.RollingUpdate.MaxUnavailable.IntValue() != 0 {
		t.Error("a rollout must not take a replica away before its replacement is ready")
	}
	// Only /tmp is writable.
	for _, m := range c.VolumeMounts {
		if m.MountPath != "/tmp" {
			t.Errorf("unexpected writable mount %s", m.MountPath)
		}
	}
}

func imagePorts(c corev1.Container) []string {
	var out []string
	for _, p := range c.Ports {
		out = append(out, fmt.Sprintf("%s:%d", p.Name, p.ContainerPort))
	}
	sort.Strings(out)
	return out
}

func TestNoSecretValueIsEverInTheManifest(t *testing.T) {
	all := render(t, "--set", "secrets.keys.masterKeyPrevious=master-key-previous", "--set", "secrets.keys.smtpPassword=smtp-password", "--set", "config.smtp.host=smtp.example.com")
	d := docs(t, all)
	dep := one[appsv1.Deployment](t, d, "Deployment")
	secretVars := map[string]bool{"DATABASE_URL": true, "REDIS_URL": true, "VFM_MASTER_KEY": true, "VFM_MASTER_KEY_PREVIOUS": true, "SMTP_PASSWORD": true}
	seen := map[string]bool{}
	for _, e := range dep.Spec.Template.Spec.Containers[0].Env {
		if secretVars[e.Name] {
			seen[e.Name] = true
			if e.Value != "" || e.ValueFrom == nil || e.ValueFrom.SecretKeyRef == nil || e.ValueFrom.SecretKeyRef.Name != secretName {
				t.Errorf("%s must be a reference to the existing Secret, got %+v", e.Name, e)
			}
		}
	}
	for name := range secretVars {
		if !seen[name] {
			t.Errorf("expected %s to be wired from the Secret", name)
		}
	}
	for _, bad := range []string{"postgres://", "postgresql://", "redis://", "rediss://"} {
		if strings.Contains(all, bad) {
			t.Errorf("a connection string (%s) appears in the rendered manifest", bad)
		}
	}
	if len(d["Secret"]) != 0 {
		t.Error("the chart must not create Secrets; secrets come from an existing one")
	}
}

// serverEnvNames reads the variable names the server's own schema declares.
func serverEnvNames(t *testing.T) map[string]bool {
	t.Helper()
	b, err := os.ReadFile(filepath.Clean(envSchema))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\s+([A-Z][A-Z0-9_]{2,}):\s`).FindAllStringSubmatch(string(b), -1) {
		names[m[1]] = true
	}
	if len(names) < 30 {
		t.Fatalf("read only %d names from the schema; the pattern is out of date", len(names))
	}
	return names
}

func TestEveryEnvironmentVariableIsOneTheServerReads(t *testing.T) {
	known := serverEnvNames(t)
	// HOME is Prisma's, in the migration job only.
	d := docs(t, render(t, "--set", "config.smtp.host=smtp.example.com", "--set", "config.smtp.user=u", "--set", "config.smtp.from=a@b.c",
		"--set", "config.publicUrl=https://x", "--set", "config.apiPublicUrl=https://x", "--set", "gateway.hostnames=a.example.com",
		"--set", "secrets.keys.masterKeyPrevious=mkp", "--set", "secrets.keys.smtpPassword=sp"))
	check := func(where string, env []corev1.EnvVar, extra ...string) {
		allowed := map[string]bool{}
		for _, e := range extra {
			allowed[e] = true
		}
		for _, e := range env {
			if !known[e.Name] && !allowed[e.Name] {
				t.Errorf("%s sets %s, which the server's env schema does not read", where, e.Name)
			}
		}
	}
	check("deployment", one[appsv1.Deployment](t, d, "Deployment").Spec.Template.Spec.Containers[0].Env)
	check("migration job", one[batchv1.Job](t, d, "Job").Spec.Template.Spec.Containers[0].Env, "HOME")
}

func TestTheServerAcceptsWhatTheChartProduces(t *testing.T) {
	// The server's own validation would reject a typo in a number or a flag; render and check the shapes it requires.
	d := docs(t, render(t))
	env := map[string]string{}
	for _, e := range one[appsv1.Deployment](t, d, "Deployment").Spec.Template.Spec.Containers[0].Env {
		env[e.Name] = e.Value
	}
	for name, want := range map[string]string{"NODE_ENV": "production", "GATEWAY_ENABLED": "true", "GATEWAY_PORT": "8443", "PORT": "3000", "METRICS_PORT": "9090", "LOG_PRETTY": "false", "WEB_DIST_DIR": "/app/web"} {
		if env[name] != want {
			t.Errorf("%s = %q, want %q", name, env[name], want)
		}
	}
	if env["GATEWAY_PUBLIC_ADDRESS"] != "agents.example.com:8443" {
		t.Errorf("GATEWAY_PUBLIC_ADDRESS = %q", env["GATEWAY_PUBLIC_ADDRESS"])
	}
}

func TestTheGatewayIsItsOwnServiceAndMetricsAreNeverPublic(t *testing.T) {
	d := docs(t, render(t, "--set", "ingress.enabled=true", "--set", "ingress.host=vfm.example.com"))
	if len(d["Service"]) != 3 {
		t.Fatalf("want 3 Services (http, gateway, metrics), got %d", len(d["Service"]))
	}
	byName := map[string]corev1.Service{}
	for _, raw := range d["Service"] {
		var s corev1.Service
		if err := sigsyaml.Unmarshal(raw, &s); err != nil {
			t.Fatal(err)
		}
		byName[s.Name] = s
	}
	gw := byName[release+"-control-plane-gateway"]
	if len(gw.Spec.Ports) != 1 || gw.Spec.Ports[0].Port != 8443 {
		t.Errorf("gateway service ports: %+v", gw.Spec.Ports)
	}
	http := byName[release+"-control-plane"]
	for _, p := range http.Spec.Ports {
		if p.TargetPort.StrVal != "http" {
			t.Errorf("the public Service must expose only the http port, found %+v", p)
		}
	}
	ing := one[networkingv1.Ingress](t, d, "Ingress")
	for _, rule := range ing.Spec.Rules {
		for _, path := range rule.HTTP.Paths {
			if path.Backend.Service.Name != release+"-control-plane" || path.Backend.Service.Port.Name != "http" {
				t.Errorf("the ingress must route only to the http port of the public Service, got %+v", path.Backend.Service)
			}
		}
	}
}

func TestMigrationsRunBeforeAnyNewPodAndAsAHardenedJob(t *testing.T) {
	job := one[batchv1.Job](t, docs(t, render(t)), "Job")
	if got := job.Annotations["helm.sh/hook"]; got != "pre-install,pre-upgrade" {
		t.Errorf("hook = %q", got)
	}
	pod := job.Spec.Template.Spec
	c := pod.Containers[0]
	if strings.Join(c.Command, " ") != "node node_modules/prisma/build/index.js migrate deploy" {
		t.Errorf("command = %v", c.Command)
	}
	if c.SecurityContext == nil || !*c.SecurityContext.ReadOnlyRootFilesystem || *c.SecurityContext.AllowPrivilegeEscalation || c.SecurityContext.Capabilities.Drop[0] != "ALL" {
		t.Errorf("the migration job is not hardened: %+v", c.SecurityContext)
	}
	if pod.RestartPolicy != corev1.RestartPolicyNever {
		t.Error("a failed migration must not be retried in place forever")
	}
	if job.Spec.ActiveDeadlineSeconds == nil {
		t.Error("a hung migration needs a deadline")
	}
	// Migrations can be turned off for those who run them another way.
	if _, ok := docs(t, render(t, "--set", "migrations.enabled=false"))["Job"]; ok {
		t.Error("migrations.enabled=false still rendered the Job")
	}
}

func TestAvailability(t *testing.T) {
	d := docs(t, render(t))
	hpa := d["HorizontalPodAutoscaler"]
	if len(hpa) != 1 || !strings.Contains(string(hpa[0]), "minReplicas: 3") {
		t.Errorf("the autoscaler must start at 3 replicas: %s", hpa)
	}
	if !strings.Contains(string(d["PodDisruptionBudget"][0]), "minAvailable: 1") {
		t.Error("the PodDisruptionBudget must keep one replica")
	}
	// Without the autoscaler the Deployment owns the replica count; with it, it must not fight the autoscaler.
	withHPA := one[appsv1.Deployment](t, d, "Deployment")
	if withHPA.Spec.Replicas != nil {
		t.Error("the Deployment must leave replicas to the autoscaler")
	}
	off := one[appsv1.Deployment](t, docs(t, render(t, "--set", "autoscaling.enabled=false")), "Deployment")
	if off.Spec.Replicas == nil || *off.Spec.Replicas < 2 {
		t.Errorf("replicas = %v, want at least 2", off.Spec.Replicas)
	}
}

func TestTheNetworkPolicyOpensExactlyThreePorts(t *testing.T) {
	np := one[networkingv1.NetworkPolicy](t, docs(t, render(t)), "NetworkPolicy")
	var ports []int
	for _, r := range np.Spec.Ingress {
		for _, p := range r.Ports {
			ports = append(ports, p.Port.IntValue())
		}
	}
	sort.Ints(ports)
	if fmt.Sprint(ports) != "[3000 8443 9090]" {
		t.Errorf("ingress ports = %v", ports)
	}
	if len(np.Spec.PolicyTypes) != 1 || np.Spec.PolicyTypes[0] != networkingv1.PolicyTypeIngress {
		t.Errorf("egress is the operator's to opt into, policy types = %v", np.Spec.PolicyTypes)
	}
	withEgress := one[networkingv1.NetworkPolicy](t, docs(t, render(t, "--set", "networkPolicy.egress.enabled=true")), "NetworkPolicy")
	if len(withEgress.Spec.Egress) == 0 {
		t.Error("egress enabled but no rule rendered (DNS at least)")
	}
}

func TestObservabilityObjectsCarryTheShippedFiles(t *testing.T) {
	d := docs(t, render(t, "--set", "metrics.serviceMonitor.enabled=true", "--set", "metrics.prometheusRule.enabled=true", "--set", "metrics.dashboard.enabled=true"))
	for _, kind := range []string{"ServiceMonitor", "PrometheusRule", "ConfigMap"} {
		if len(d[kind]) != 1 {
			t.Fatalf("want one %s", kind)
		}
	}
	// The chart's copies are the files the project ships and tests; they must not drift.
	for _, f := range []string{"vfm-alerts.rules.yaml", "vfm-control-plane.dashboard.json"} {
		a, err := os.ReadFile(filepath.Join(obsDir, f)) //nolint:gosec // a fixed set of repository files
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(chartDir, "files", f)) //nolint:gosec // a fixed set of repository files
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a, b) {
			t.Errorf("%s in the chart differs from deploy/observability/%s: copy it again", f, f)
		}
	}
	var rule struct {
		Spec struct {
			Groups []struct{ Rules []map[string]any } `json:"groups"`
		} `json:"spec"`
	}
	if err := sigsyaml.Unmarshal(d["PrometheusRule"][0], &rule); err != nil || len(rule.Spec.Groups) == 0 || len(rule.Spec.Groups[0].Rules) == 0 {
		t.Errorf("the PrometheusRule has no rules: %v %+v", err, rule)
	}
}

func TestHelmLintIsClean(t *testing.T) {
	out, err := helm(t, append([]string{"lint", chartDir}, required...)...)
	if err != nil {
		t.Fatalf("helm lint: %v\n%s", err, out)
	}
}

func TestTheDefaultsKeepTheDatabaseUnderItsConnectionLimit(t *testing.T) {
	// replicas x pool must fit Postgres's default max_connections (100) at the autoscaler's ceiling (OPERATIONS.md).
	d := docs(t, render(t))
	var pool int
	for _, e := range one[appsv1.Deployment](t, d, "Deployment").Spec.Template.Spec.Containers[0].Env {
		if e.Name == "DATABASE_POOL_MAX" {
			_, _ = fmt.Sscan(e.Value, &pool)
		}
	}
	if !strings.Contains(string(d["HorizontalPodAutoscaler"][0]), "maxReplicas: 6") {
		t.Fatal("test out of date: maxReplicas is no longer 6")
	}
	if pool*6 >= 100 {
		t.Errorf("6 replicas x pool %d = %d connections, which does not fit Postgres's default limit of 100", pool, pool*6)
	}
}
