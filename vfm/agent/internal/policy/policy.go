// Package policy is the agent-side defence in depth of PLAN.md §5.5: a policy the
// cluster owner sets at install time, which the control plane cannot change and
// the agent enforces before it executes anything.
//
// The control plane has its own RBAC. This exists for the day that RBAC is wrong,
// bypassed or compromised: whoever owns the cluster can still say "this agent never
// restores into kube-system", and mean it.
package policy

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	pb "github.com/shubhambatra/velero-fe/vfm/agent/internal/pb/vfm/agent/v1"
)

// namespaceName is what a plain namespace name looks like (an RFC 1123 label). Anything
// else in a namespace filter is a pattern or garbage, and a pattern can stand for a
// protected namespace without ever spelling it.
var namespaceName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)

// plainName reports whether s can only ever mean the one namespace it names.
func plainName(s string) bool { return namespaceName.MatchString(s) }

// Policy is the set of rules in the `vfm-agent-policy` ConfigMap.
type Policy struct {
	AllowRestore              bool
	RestoreDeniedNamespaces   []string
	AllowBslWrite             bool
	AllowLogStreaming         bool
	LogStreamDeniedNamespaces []string
	// ReadOnly rejects every command that changes anything.
	ReadOnly bool
	// AllowClusterScopedRestore (threat model G-4). When false a restore must say
	// `includeClusterResources: false`: Velero treats the field being unset as true, which would let a
	// restore recreate CRDs, ClusterRoleBindings and PersistentVolumes. Default true.
	AllowClusterScopedRestore bool
}

// Default is the policy used when no ConfigMap exists (PLAN.md §5.5).
func Default() Policy {
	return Policy{
		AllowRestore:              true,
		RestoreDeniedNamespaces:   []string{"kube-system", "vfm-system", "velero"},
		AllowBslWrite:             true,
		AllowLogStreaming:         true,
		LogStreamDeniedNamespaces: []string{},
		ReadOnly:                  false,
		AllowClusterScopedRestore: true,
	}
}

// Lockdown is what a **malformed** policy becomes: nothing that changes the
// cluster may run. A broken policy must never silently widen what the agent does.
func Lockdown() Policy {
	return Policy{
		AllowRestore:              false,
		RestoreDeniedNamespaces:   []string{"*"},
		AllowBslWrite:             false,
		AllowLogStreaming:         false,
		LogStreamDeniedNamespaces: []string{"*"},
		ReadOnly:                  true,
		AllowClusterScopedRestore: false,
	}
}

// Denial is why a command was refused.
type Denial struct{ Reason string }

func (d *Denial) Error() string { return d.Reason }

// Proto is the policy as reported in Hello, so the UI can show disabled actions
// with the reason.
func (p Policy) Proto() *pb.AgentPolicy {
	return &pb.AgentPolicy{
		AllowRestore:              p.AllowRestore,
		RestoreDeniedNamespaces:   slices.Clone(p.RestoreDeniedNamespaces),
		AllowBslWrite:             p.AllowBslWrite,
		AllowLogStreaming:         p.AllowLogStreaming,
		LogStreamDeniedNamespaces: slices.Clone(p.LogStreamDeniedNamespaces),
		ReadOnly:                  p.ReadOnly,
		DenyClusterScopedRestore:  !p.AllowClusterScopedRestore,
	}
}

// Parse reads ConfigMap data. Unknown keys are an error rather than ignored: a
// typo such as `allowRestor: false` must not leave a restriction the owner thinks
// they set silently unset.
func Parse(data map[string]string) (Policy, error) {
	p := Default()
	var problems []string

	for key, raw := range data {
		value := strings.TrimSpace(raw)
		switch key {
		case "allowRestore":
			p.AllowRestore, problems = parseBool(key, value, problems)
		case "allowBslWrite":
			p.AllowBslWrite, problems = parseBool(key, value, problems)
		case "allowLogStreaming":
			p.AllowLogStreaming, problems = parseBool(key, value, problems)
		case "readOnly":
			p.ReadOnly, problems = parseBool(key, value, problems)
		case "allowClusterScopedRestore":
			p.AllowClusterScopedRestore, problems = parseBool(key, value, problems)
		case "restoreDeniedNamespaces":
			p.RestoreDeniedNamespaces, problems = parseList(key, value, problems)
		case "logStreamDeniedNamespaces":
			p.LogStreamDeniedNamespaces, problems = parseList(key, value, problems)
		default:
			problems = append(problems, fmt.Sprintf("unknown key %q", key))
		}
	}
	if len(problems) > 0 {
		slices.Sort(problems)
		return Lockdown(), fmt.Errorf("invalid policy: %s", strings.Join(problems, "; "))
	}
	return p, nil
}

func parseBool(key, value string, problems []string) (bool, []string) {
	b, err := strconv.ParseBool(value)
	if err != nil {
		return false, append(problems, fmt.Sprintf("%s must be true or false", key))
	}
	return b, problems
}

// parseList accepts a JSON array, a YAML flow list (`[a, b]`) or a comma list.
func parseList(key, value string, problems []string) ([]string, []string) {
	value = strings.TrimSpace(value)
	if value == "" || value == "[]" {
		return []string{}, problems
	}
	var items []string
	if strings.HasPrefix(value, "[") {
		if err := json.Unmarshal([]byte(value), &items); err != nil {
			inner := strings.TrimSuffix(strings.TrimPrefix(value, "["), "]")
			items = strings.Split(inner, ",")
		}
	} else {
		items = strings.Split(value, ",")
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.Trim(strings.TrimSpace(item), `"'`)
		if item == "" {
			continue
		}
		if len(item) > 63 {
			return nil, append(problems, key+" has a namespace name that is too long")
		}
		out = append(out, item)
	}
	return out, problems
}

// Load reads the policy ConfigMap. A missing ConfigMap means the default; an
// unreadable or malformed one means [Lockdown], returned together with the error
// so the caller can log why.
func Load(ctx context.Context, client kubernetes.Interface, namespace, name string) (Policy, error) {
	cm, err := client.CoreV1().ConfigMaps(namespace).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return Default(), nil
	}
	if err != nil {
		return Lockdown(), fmt.Errorf("read policy ConfigMap: %w", err)
	}
	return Parse(cm.Data)
}

// mutating reports whether a command changes anything. `RefreshServerStatus`
// creates a short-lived diagnostic object in Velero's namespace and is the one
// command allowed in read-only mode: it is how the UI learns the Velero version.
func mutating(cmd *pb.Command) bool {
	switch cmd.GetOp().(type) {
	// A DownloadRequest is a transient request object like a ServerStatusRequest: it
	// changes nothing the owner cares about, and reading logs must work read-only.
	case *pb.Command_RefreshStatus, *pb.Command_FetchDownload, *pb.Command_CheckNamespaces, *pb.Command_GetBackupDownloadUrl:
		return false
	default:
		return true
	}
}

// Check decides whether cmd may run. It returns nil when allowed.
func (p Policy) Check(cmd *pb.Command) *Denial {
	if p.ReadOnly && mutating(cmd) {
		return &Denial{Reason: "this agent is in read-only mode"}
	}

	switch op := cmd.GetOp().(type) {
	case *pb.Command_CreateRestore:
		if !p.AllowRestore {
			return &Denial{Reason: "restores are disabled on this cluster"}
		}
		spec := op.CreateRestore.GetSpec()
		if denial := p.CheckRestoreClusterScope(spec.IncludeClusterResources); denial != nil {
			return denial
		}
		return p.CheckRestoreScope(spec.GetIncludedNamespaces(), spec.GetExcludedNamespaces(), spec.GetNamespaceMapping())

	case *pb.Command_UpsertBsl, *pb.Command_SetDefaultBsl, *pb.Command_DeleteBsl,
		*pb.Command_UpsertVsl, *pb.Command_DeleteVsl:
		if !p.AllowBslWrite {
			return &Denial{Reason: "changing storage locations is disabled on this cluster"}
		}
	}
	return nil
}

// CheckRestoreClusterScope applies AllowClusterScopedRestore (threat model G-4). `include` is the spec's
// includeClusterResources as it will really be created; nil is "not set", which Velero v1.18 treats as
// true (RestoreSpec.IncludeClusterResources: "If null, defaults to true"), so only an explicit false passes.
func (p Policy) CheckRestoreClusterScope(include *bool) *Denial {
	if p.AllowClusterScopedRestore || (include != nil && !*include) {
		return nil
	}
	return &Denial{Reason: "restoring cluster-scoped resources (CRDs, ClusterRoleBindings, PersistentVolumes...) is not permitted on this cluster; set cluster-scoped resources to No"}
}

// CheckRestoreScope refuses a restore that could write into a protected
// namespace: by naming it, by mapping into it, or by naming no namespaces at all
// (which means every namespace) without excluding the protected ones.
//
// It takes the namespaces rather than a command so that it can be applied again to
// the spec as it will really be created: the advanced settings are merged onto the
// typed spec only on the agent, after [Policy.Check] has run, and they can say
// anything the typed fields can.
func (p Policy) CheckRestoreScope(included, excluded []string, mapping map[string]string) *Denial {
	denied := p.RestoreDeniedNamespaces
	if len(denied) == 0 {
		return nil
	}
	if slices.Contains(denied, "*") {
		return &Denial{Reason: "restores are not permitted into any namespace on this cluster"}
	}

	// Velero accepts patterns (`kube-*`, `kube-?ystem`, `[k]ube-system`) in the namespace filters,
	// so a spec that names no protected namespace can still reach one. Where a namespace is
	// protected, only plain names are accepted in what a restore reads and writes.
	for _, ns := range included {
		if ns != "*" && !plainName(ns) {
			return &Denial{Reason: fmt.Sprintf("the namespace filter %q is not a plain namespace name; patterns are not permitted on a cluster with protected namespaces", ns)}
		}
	}
	for _, target := range mapping {
		if !plainName(target) {
			return &Denial{Reason: fmt.Sprintf("the mapped namespace %q is not a plain namespace name", target)}
		}
		if slices.Contains(denied, target) {
			return &Denial{Reason: fmt.Sprintf("restoring into namespace %q is not permitted on this cluster", target)}
		}
	}

	if len(included) == 0 || slices.Contains(included, "*") {
		for _, ns := range denied {
			if !slices.Contains(excluded, ns) {
				return &Denial{Reason: fmt.Sprintf(
					"a restore of all namespaces would include %q, which is protected on this cluster; list the namespaces to restore or exclude it", ns)}
			}
		}
		return nil
	}
	for _, ns := range included {
		if slices.Contains(denied, ns) {
			return &Denial{Reason: fmt.Sprintf("restoring namespace %q is not permitted on this cluster", ns)}
		}
	}
	return nil
}

// CheckLogSession decides whether logs may be streamed from a namespace.
func (p Policy) CheckLogSession(namespace string) *Denial {
	if !p.AllowLogStreaming {
		return &Denial{Reason: "log streaming is disabled on this cluster"}
	}
	if slices.Contains(p.LogStreamDeniedNamespaces, "*") || slices.Contains(p.LogStreamDeniedNamespaces, namespace) {
		return &Denial{Reason: fmt.Sprintf("logs from namespace %q cannot be streamed on this cluster", namespace)}
	}
	return nil
}
