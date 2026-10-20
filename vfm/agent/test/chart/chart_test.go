// Package chart_test renders the agent's Helm chart and checks it against the
// agent and against PLAN.md.
//
// It is what makes "agent RBAC exactly matches §12.2" (PLAN.md §19 checklist) a
// check that runs on every change rather than a sentence in a review: the expected
// rules below are written out here, independently of the chart's own text.
//
// The tests need the `helm` binary. In CI it is always present and the tests set
// VFM_REQUIRE_HELM=1, so a missing helm fails instead of silently skipping.
// NOTE: run with -count=1 (the Makefile and CI do). Go's test cache cannot see the chart, which is outside
// the Go module, so a changed chart would otherwise be answered from the cache.
package chart_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/util/yaml"

	"github.com/shubhambatra/velero-fe/vfm/agent/internal/config"
	"github.com/shubhambatra/velero-fe/vfm/agent/internal/policy"
)

const (
	chartDir = "../../../deploy/helm/vfm-agent"
	release  = "vfm-agent"
	agentNS  = "vfm-system"
	pemCA    = "-----BEGIN CERTIFICATE-----\nMIIBabc+/=\n-----END CERTIFICATE-----\n"
)

// helmTemplate renders the chart. extra is appended to the helm arguments.
func helmTemplate(t *testing.T, extra ...string) (string, error) {
	t.Helper()
	helm, err := exec.LookPath("helm")
	if err != nil {
		if os.Getenv("VFM_REQUIRE_HELM") != "" {
			t.Fatal("helm is required (VFM_REQUIRE_HELM is set) but was not found")
		}
		t.Skip("helm not installed; the chart tests are skipped")
	}
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, []byte(pemCA), 0o600); err != nil {
		t.Fatal(err)
	}
	args := append([]string{
		"template", release, chartDir, "--namespace", agentNS,
		"--set", "controlPlane.address=vfm.example.com:8443",
		"--set-file", "controlPlane.caBundle=" + ca,
	}, extra...)
	cmd := exec.Command(helm, args...) //nolint:gosec // fixed binary, test-controlled arguments
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%w: %s", err, errb.String())
	}
	return out.String(), nil
}

// objects splits rendered output into decoded documents keyed by kind.
func objects(t *testing.T, rendered string) map[string][]map[string]any {
	t.Helper()
	out := map[string][]map[string]any{}
	dec := yaml.NewYAMLOrJSONDecoder(strings.NewReader(rendered), 4096)
	for {
		var doc map[string]any
		if err := dec.Decode(&doc); err != nil {
			if err.Error() == "EOF" {
				return out
			}
			t.Fatalf("decode: %v", err)
		}
		if doc == nil {
			continue
		}
		kind, _ := doc["kind"].(string)
		out[kind] = append(out[kind], doc)
	}
}

func decodeInto[T any](t *testing.T, doc map[string]any) T {
	t.Helper()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// flatten turns rules into one sorted line per (group, resource, names, verb).
func flatten(rules []rbacv1.PolicyRule) []string {
	var out []string
	for _, r := range rules {
		for _, g := range r.APIGroups {
			for _, res := range r.Resources {
				for _, v := range r.Verbs {
					names := "*any*"
					if len(r.ResourceNames) > 0 {
						names = strings.Join(r.ResourceNames, ",")
					}
					out = append(out, fmt.Sprintf("%q %s [%s] %s", g, res, names, v))
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

func expand(group string, resources, verbs []string, names ...string) []string {
	var out []string
	for _, res := range resources {
		for _, v := range verbs {
			n := "*any*"
			if len(names) > 0 {
				n = strings.Join(names, ",")
			}
			out = append(out, fmt.Sprintf("%q %s [%s] %s", group, res, n, v))
		}
	}
	return out
}

func sorted(parts ...[]string) []string {
	var all []string
	for _, p := range parts {
		all = append(all, p...)
	}
	sort.Strings(all)
	return all
}

func diff(t *testing.T, what string, got, want []string) {
	t.Helper()
	g, w := map[string]bool{}, map[string]bool{}
	for _, x := range got {
		g[x] = true
	}
	for _, x := range want {
		w[x] = true
	}
	for _, x := range got {
		if !w[x] {
			t.Errorf("%s: the chart grants %s, which PLAN.md §12.2 does not", what, x)
		}
	}
	for _, x := range want {
		if !g[x] {
			t.Errorf("%s: the chart is missing %s, which the agent needs", what, x)
		}
	}
}

func TestRBACMatchesPlanSection12_2Exactly(t *testing.T) {
	rendered, err := helmTemplate(t)
	if err != nil {
		t.Fatal(err)
	}
	objs := objects(t, rendered)

	if got := len(objs["ClusterRole"]); got != 1 {
		t.Fatalf("want exactly 1 ClusterRole, got %d", got)
	}
	cluster := decodeInto[rbacv1.ClusterRole](t, objs["ClusterRole"][0])
	diff(t, "ClusterRole", flatten(cluster.Rules), sorted(
		// Cluster-wide read, and pod logs.
		expand("", []string{"nodes", "namespaces", "pods", "persistentvolumeclaims", "events"}, []string{"get", "list", "watch"}),
		expand("", []string{"pods/log"}, []string{"get"}),
	))

	var velero, own *rbacv1.Role
	for _, doc := range objs["Role"] {
		r := decodeInto[rbacv1.Role](t, doc)
		switch r.Namespace {
		case "velero":
			velero = &r
		case agentNS:
			own = &r
		default:
			t.Errorf("Role %q in unexpected namespace %q", r.Name, r.Namespace)
		}
	}
	if velero == nil || own == nil {
		t.Fatalf("want a Role in velero and one in %s", agentNS)
	}

	diff(t, "Role in the Velero namespace", flatten(velero.Rules), sorted(
		expand("velero.io", []string{"backups", "restores", "schedules", "backupstoragelocations", "volumesnapshotlocations",
			"deletebackuprequests", "downloadrequests", "serverstatusrequests"},
			[]string{"get", "list", "watch", "create", "update", "patch", "delete"}),
		expand("velero.io", []string{"backuprepositories", "podvolumebackups", "podvolumerestores", "datauploads", "datadownloads"},
			[]string{"get", "list", "watch"}),
		// Credentials for backup and snapshot locations, in the Velero namespace only.
		expand("", []string{"secrets"}, []string{"get", "create", "update"}),
	))

	diff(t, "Role in the agent namespace", flatten(own.Rules), sorted(
		expand("", []string{"secrets"}, []string{"create"}),
		expand("", []string{"secrets"}, []string{"get", "update"}, config.DefaultCredentialsSecret),
		expand("", []string{"configmaps"}, []string{"create"}),
		expand("", []string{"configmaps"}, []string{"get", "update"}, config.DefaultStateConfigMap),
		// The policy is the owner's: read-only for the agent.
		expand("", []string{"configmaps"}, []string{"get"}, config.DefaultPolicyConfigMap),
		expand("coordination.k8s.io", []string{"leases"}, []string{"create"}),
		expand("coordination.k8s.io", []string{"leases"}, []string{"get", "update"}, config.DefaultLeaseName),
	))
}

func TestNoRuleIsEverBroad(t *testing.T) {
	// Run with values that would tempt a careless template: a custom Velero namespace.
	rendered, err := helmTemplate(t, "--set", "velero.namespace=backup-system")
	if err != nil {
		t.Fatal(err)
	}
	objs := objects(t, rendered)
	var all []rbacv1.PolicyRule
	for _, doc := range objs["ClusterRole"] {
		all = append(all, decodeInto[rbacv1.ClusterRole](t, doc).Rules...)
	}
	for _, doc := range objs["Role"] {
		all = append(all, decodeInto[rbacv1.Role](t, doc).Rules...)
	}
	for _, r := range all {
		for _, field := range [][]string{r.APIGroups, r.Resources, r.Verbs} {
			for _, v := range field {
				if v == "*" {
					t.Errorf("wildcard in rule %+v", r)
				}
			}
		}
		for _, res := range r.Resources {
			if strings.HasSuffix(res, "/exec") || strings.HasSuffix(res, "/attach") || strings.HasSuffix(res, "/portforward") || res == "pods/proxy" {
				t.Errorf("rule grants %s: the agent never opens a shell into a customer's workloads", res)
			}
		}
	}
	for _, doc := range objs["ClusterRole"] {
		for _, r := range decodeInto[rbacv1.ClusterRole](t, doc).Rules {
			for _, res := range r.Resources {
				if res == "secrets" {
					t.Error("a ClusterRole grants Secrets: there must be no cluster-wide Secret access")
				}
			}
		}
	}

	// The custom namespace moved the Velero Role and nothing else.
	found := false
	for _, doc := range objs["Role"] {
		if decodeInto[rbacv1.Role](t, doc).Namespace == "backup-system" {
			found = true
		}
	}
	if !found {
		t.Error("velero.namespace did not move the Velero Role")
	}
}

func deployment(t *testing.T, extra ...string) appsv1.Deployment {
	t.Helper()
	rendered, err := helmTemplate(t, extra...)
	if err != nil {
		t.Fatal(err)
	}
	docs := objects(t, rendered)["Deployment"]
	if len(docs) != 1 {
		t.Fatalf("want 1 Deployment, got %d", len(docs))
	}
	return decodeInto[appsv1.Deployment](t, docs[0])
}

func envOf(d appsv1.Deployment) map[string]corev1.EnvVar {
	out := map[string]corev1.EnvVar{}
	for _, e := range d.Spec.Template.Spec.Containers[0].Env {
		out[e.Name] = e
	}
	return out
}

func TestTheDeploymentIsHardenedAndHasTwoReplicas(t *testing.T) {
	d := deployment(t)
	if d.Spec.Replicas == nil || *d.Spec.Replicas != 2 {
		t.Errorf("replicas = %v, want 2 (leader and standby, PLAN.md §3.2)", d.Spec.Replicas)
	}
	pod := d.Spec.Template.Spec
	if pod.SecurityContext == nil || pod.SecurityContext.RunAsNonRoot == nil || !*pod.SecurityContext.RunAsNonRoot {
		t.Error("the pod does not require a non-root user")
	}
	if pod.SecurityContext.SeccompProfile == nil || pod.SecurityContext.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Error("no RuntimeDefault seccomp profile")
	}
	c := pod.Containers[0]
	sc := c.SecurityContext
	if sc == nil {
		t.Fatal("the container has no securityContext")
	}
	if sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem {
		t.Error("the root filesystem is writable")
	}
	if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Error("privilege escalation is allowed")
	}
	if sc.Privileged == nil || *sc.Privileged {
		t.Error("the container is privileged")
	}
	if sc.Capabilities == nil || len(sc.Capabilities.Drop) != 1 || sc.Capabilities.Drop[0] != "ALL" {
		t.Error("capabilities are not all dropped")
	}
	if c.Resources.Limits.Memory().IsZero() || c.Resources.Requests.Cpu().IsZero() {
		t.Error("resource requests and limits must be set")
	}
	if pod.ServiceAccountName != "vfm-agent" {
		t.Errorf("service account = %q", pod.ServiceAccountName)
	}
	if c.LivenessProbe == nil || c.ReadinessProbe == nil {
		t.Error("probes missing")
	}
	for _, v := range pod.Volumes {
		if v.HostPath != nil {
			t.Errorf("volume %q mounts the host", v.Name)
		}
	}
}

func TestEveryEnvironmentVariableIsOneTheAgentActuallyReads(t *testing.T) {
	d := deployment(t,
		"--set", "controlPlane.serverName=gateway.internal",
		"--set", "enrollment.token=tok",
		"--set", "proxy.httpsProxy=http://proxy:3128",
	)
	env := envOf(d)

	// The agent's own constants, not hand-copied strings: a rename or a wrong prefix
	// in the chart fails here instead of producing an agent that silently ignores it.
	for _, name := range []string{
		config.EnvControlPlaneAddress, config.EnvControlPlaneCAFile, config.EnvServerName,
		config.EnvNamespace, config.EnvInstanceID, config.EnvVeleroNamespace,
		config.EnvCredentialsSecret, config.EnvStateConfigMap, config.EnvPolicyConfigMap,
		config.EnvLogLevel, config.EnvChartVersion, config.EnvImageTag, config.EnvEnrollmentToken,
	} {
		if _, ok := env[name]; !ok {
			t.Errorf("the chart does not set %s", name)
		}
	}
	for name := range env {
		if strings.HasPrefix(name, "VFM_") && !knownConfigEnv(name) {
			t.Errorf("the chart sets %s, which the agent does not read", name)
		}
	}

	// The names the RBAC is written against are the names the agent will use.
	want := map[string]string{
		config.EnvCredentialsSecret:   config.DefaultCredentialsSecret,
		config.EnvStateConfigMap:      config.DefaultStateConfigMap,
		config.EnvPolicyConfigMap:     config.DefaultPolicyConfigMap,
		config.EnvVeleroNamespace:     "velero",
		config.EnvControlPlaneAddress: "vfm.example.com:8443",
	}
	for k, v := range want {
		if env[k].Value != v {
			t.Errorf("%s = %q, want %q", k, env[k].Value, v)
		}
	}
	if env[config.EnvNamespace].ValueFrom == nil || env[config.EnvInstanceID].ValueFrom == nil {
		t.Error("namespace and instance id must come from the downward API")
	}
	if env["HTTPS_PROXY"].Value != "http://proxy:3128" {
		t.Errorf("HTTPS_PROXY = %q", env["HTTPS_PROXY"].Value)
	}
}

// knownConfigEnv is every variable config.Load reads, so the chart cannot invent one.
func knownConfigEnv(name string) bool {
	known := []string{
		config.EnvControlPlaneAddress, config.EnvControlPlaneCAFile, config.EnvServerName, config.EnvCredentialsSecret,
		config.EnvEnrollmentToken, config.EnvPolicyConfigMap, config.EnvStateConfigMap, config.EnvVeleroNamespace,
		config.EnvChartVersion, config.EnvImageTag, config.EnvClusterID, config.EnvClusterName, config.EnvInstanceID,
		config.EnvNamespace, config.EnvKubeconfig, config.EnvDev, config.EnvHealthAddr, config.EnvMetricsAddr,
		config.EnvLogLevel, config.EnvLogFormat, config.EnvHeartbeatInterval, config.EnvLeaderElection, config.EnvLeaseName,
		config.EnvLeaseDuration, config.EnvLeaseRenewDeadline, config.EnvLeaseRetryPeriod, config.EnvReadyRequiresLeadership,
		config.EnvShutdownTimeout, config.EnvKubeQPS, config.EnvKubeBurst, config.EnvKubeTimeout,
	}
	for _, k := range known {
		if k == name {
			return true
		}
	}
	return false
}

func TestTheRenderedEnvironmentIsAcceptedByTheAgentsOwnConfigLoader(t *testing.T) {
	d := deployment(t, "--set", "controlPlane.serverName=gateway.internal")
	vars := map[string]string{}
	for name, e := range envOf(d) {
		switch {
		case e.ValueFrom != nil && e.ValueFrom.FieldRef != nil && e.ValueFrom.FieldRef.FieldPath == "metadata.namespace":
			vars[name] = agentNS
		case e.ValueFrom != nil && e.ValueFrom.FieldRef != nil:
			vars[name] = "vfm-agent-7d9f-abcde"
		case e.ValueFrom != nil:
			vars[name] = "secret-value"
		default:
			vars[name] = e.Value
		}
	}
	cfg, err := config.Load(nil, func(k string) (string, bool) { v, ok := vars[k]; return v, ok })
	if err != nil {
		t.Fatalf("the agent rejects the environment the chart gives it: %v", err)
	}
	if cfg.ControlPlaneCAFile != "/etc/vfm/ca/ca.pem" || cfg.ServerName != "gateway.internal" || cfg.Namespace != agentNS {
		t.Errorf("config = %+v", cfg)
	}
}

func TestTheMountedCAIsTheOneTheAgentIsToldToRead(t *testing.T) {
	d := deployment(t)
	c := d.Spec.Template.Spec.Containers[0]
	var mount string
	for _, m := range c.VolumeMounts {
		if m.Name == "ca" {
			mount = m.MountPath
		}
	}
	if got := envOf(d)[config.EnvControlPlaneCAFile].Value; got != mount+"/ca.pem" {
		t.Errorf("CA file env %q is not under the mount %q", got, mount)
	}
}

func TestThePolicyConfigMapIsWhatTheAgentsParserExpects(t *testing.T) {
	rendered, err := helmTemplate(t)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]string
	for _, doc := range objects(t, rendered)["ConfigMap"] {
		cm := decodeInto[corev1.ConfigMap](t, doc)
		if cm.Name == config.DefaultPolicyConfigMap {
			data = cm.Data
		}
	}
	if data == nil {
		t.Fatal("no policy ConfigMap")
	}
	got, err := policy.Parse(data)
	if err != nil {
		t.Fatalf("the agent cannot parse the policy the chart renders (it would lock down): %v", err)
	}
	want := policy.Default()
	if got.AllowRestore != want.AllowRestore || got.AllowBslWrite != want.AllowBslWrite || got.ReadOnly != want.ReadOnly ||
		strings.Join(got.RestoreDeniedNamespaces, ",") != strings.Join(want.RestoreDeniedNamespaces, ",") {
		t.Errorf("default chart values do not equal the agent's default policy:\n got  %+v\n want %+v", got, want)
	}
}

func TestPolicyOverridesReachTheAgent(t *testing.T) {
	rendered, err := helmTemplate(t,
		"--set", "policy.readOnly=true",
		"--set", "policy.allowRestore=false",
		"--set", "policy.restoreDeniedNamespaces={prod,payments}",
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, doc := range objects(t, rendered)["ConfigMap"] {
		cm := decodeInto[corev1.ConfigMap](t, doc)
		if cm.Name != config.DefaultPolicyConfigMap {
			continue
		}
		p, err := policy.Parse(cm.Data)
		if err != nil {
			t.Fatal(err)
		}
		if !p.ReadOnly || p.AllowRestore || strings.Join(p.RestoreDeniedNamespaces, ",") != "prod,payments" {
			t.Errorf("overrides lost: %+v", p)
		}
	}
}

func TestTheEnrollmentTokenIsASecretReferenceAndOptionalAfterwards(t *testing.T) {
	rendered, err := helmTemplate(t, "--set", "enrollment.token=very-secret-token")
	if err != nil {
		t.Fatal(err)
	}
	docs := objects(t, rendered)
	if len(docs["Secret"]) != 1 {
		t.Fatalf("want one Secret for the token, got %d", len(docs["Secret"]))
	}
	d := decodeInto[appsv1.Deployment](t, docs["Deployment"][0])
	e := envOf(d)[config.EnvEnrollmentToken]
	if e.Value != "" || e.ValueFrom == nil || e.ValueFrom.SecretKeyRef == nil {
		t.Fatalf("the token must come from a Secret, never inline: %+v", e)
	}
	if e.ValueFrom.SecretKeyRef.Optional == nil || !*e.ValueFrom.SecretKeyRef.Optional {
		t.Error("the token Secret must be optional so it can be removed after enrollment")
	}
	// And it appears nowhere in the Deployment itself.
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), "very-secret-token") {
		t.Error("the token leaked into the Deployment")
	}

	// No token, no env var and no Secret.
	rendered, _ = helmTemplate(t)
	docs = objects(t, rendered)
	if len(docs["Secret"]) != 0 {
		t.Error("a Secret was rendered without a token")
	}
	d = decodeInto[appsv1.Deployment](t, docs["Deployment"][0])
	if _, present := envOf(d)[config.EnvEnrollmentToken]; present {
		t.Error("the token env var is set without a token")
	}

	// An existing Secret is referenced, not copied.
	rendered, _ = helmTemplate(t, "--set", "enrollment.existingSecret=my-token", "--set", "enrollment.existingSecretKey=t")
	docs = objects(t, rendered)
	if len(docs["Secret"]) != 0 {
		t.Error("a Secret was rendered although an existing one was named")
	}
	d = decodeInto[appsv1.Deployment](t, docs["Deployment"][0])
	if ref := envOf(d)[config.EnvEnrollmentToken].ValueFrom.SecretKeyRef; ref.Name != "my-token" || ref.Key != "t" {
		t.Errorf("existing secret reference = %+v", ref)
	}
}

func TestThePodDisruptionBudgetKeepsOneReplica(t *testing.T) {
	rendered, err := helmTemplate(t)
	if err != nil {
		t.Fatal(err)
	}
	pdbs := objects(t, rendered)["PodDisruptionBudget"]
	if len(pdbs) != 1 {
		t.Fatalf("want 1 PDB, got %d", len(pdbs))
	}
	pdb := decodeInto[policyv1.PodDisruptionBudget](t, pdbs[0])
	if pdb.Spec.MinAvailable == nil || pdb.Spec.MinAvailable.IntValue() != 1 {
		t.Errorf("minAvailable = %v", pdb.Spec.MinAvailable)
	}

	rendered, _ = helmTemplate(t, "--set", "podDisruptionBudget.enabled=false")
	if len(objects(t, rendered)["PodDisruptionBudget"]) != 0 {
		t.Error("the PDB was rendered although disabled")
	}
}

func TestTheImageDefaultsToTheChartVersionAndCanBeOverridden(t *testing.T) {
	if got := deployment(t).Spec.Template.Spec.Containers[0].Image; got != "ghcr.io/shubhambatra/vfm-agent:0.1.0" {
		t.Errorf("default image = %q", got)
	}
	d := deployment(t, "--set", "image.repository=registry.internal/mirror/vfm-agent", "--set", "image.tag=sha-abc123")
	if got := d.Spec.Template.Spec.Containers[0].Image; got != "registry.internal/mirror/vfm-agent:sha-abc123" {
		t.Errorf("overridden image = %q", got)
	}
	if got := envOf(d)[config.EnvImageTag].Value; got != "sha-abc123" {
		t.Errorf("Hello would report image tag %q", got)
	}
}

func TestTheChartRefusesToInstallWithoutTheThingsItCannotWorkWithout(t *testing.T) {
	helm, err := exec.LookPath("helm")
	if err != nil {
		t.Skip("helm not installed")
	}
	for name, args := range map[string][]string{
		"no control plane at all":  {"--set", "enrollment.token=x"},
		"no CA bundle":             {"--set", "controlPlane.address=vfm.example.com:8443"},
		"a CA bundle that is junk": {"--set", "controlPlane.address=vfm.example.com:8443", "--set", "controlPlane.caBundle=not a certificate"},
		"zero replicas":            {"--set", "controlPlane.address=a:1", "--set", "controlPlane.caBundle=-----BEGIN CERTIFICATE-----", "--set", "replicaCount=0"},
		"an unknown policy key":    {"--set", "controlPlane.address=a:1", "--set", "controlPlane.caBundle=-----BEGIN CERTIFICATE-----", "--set", "policy.allowRestor=false"},
	} {
		out, err := exec.Command(helm, append([]string{"template", release, chartDir, "--namespace", agentNS}, args...)...).CombinedOutput() //nolint:gosec // fixed binary, test-controlled arguments
		if err == nil {
			t.Errorf("%s: helm rendered the chart anyway:\n%s", name, out)
		}
	}
}

func TestTheClusterScopedRestoreSwitchReachesTheAgent(t *testing.T) {
	policyOf := func(extra ...string) policy.Policy {
		rendered, err := helmTemplate(t, extra...)
		if err != nil {
			t.Fatal(err)
		}
		for _, doc := range objects(t, rendered)["ConfigMap"] {
			cm := decodeInto[corev1.ConfigMap](t, doc)
			if cm.Name != config.DefaultPolicyConfigMap {
				continue
			}
			p, err := policy.Parse(cm.Data)
			if err != nil {
				t.Fatal(err)
			}
			return p
		}
		t.Fatal("no policy ConfigMap rendered")
		return policy.Policy{}
	}
	if !policyOf().AllowClusterScopedRestore {
		t.Error("cluster-scoped restores must be allowed by default (threat model G-4: the owner opts in to the restriction)")
	}
	if policyOf("--set", "policy.allowClusterScopedRestore=false").AllowClusterScopedRestore {
		t.Error("policy.allowClusterScopedRestore=false did not reach the agent")
	}
}
