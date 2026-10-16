package config

// Product naming for the whole Go module lives here and nowhere else.
//
// PLAN.md's preamble requires the working name to sit in one constant per
// package "so a rename is trivial". This file is the Go mirror of
// vfm/packages/shared/src/product.ts, which carries the same constants for the
// control plane and the web app and points here for the agent. Change the two
// files together; nothing else in this module may hard-code the product name.
const (
	// ProductName is the full product name, for help text and documentation.
	ProductName = "Velero Fleet Manager"

	// ProductShortName is the compact name, used in log fields and metrics.
	ProductShortName = "VFM"

	// ProductSlug is the slug used in identifiers that are expensive to change
	// later: the namespace, the label/annotation domain and metric names.
	// Renaming the product does NOT mean renaming this — doing so is a breaking
	// change for already-enrolled clusters.
	ProductSlug = "vfm"

	// AgentNamespace is the namespace the agent is installed into (PLAN.md §3).
	AgentNamespace = ProductSlug + "-system"

	// ResourceDomain prefixes every label and annotation the agent writes onto
	// Velero objects, e.g. "vfm.io/command-id" (PLAN.md §5.4).
	ResourceDomain = ProductSlug + ".io"

	// ComponentName identifies this binary in logs, metrics and user agents.
	ComponentName = ProductSlug + "-agent"

	// EnvPrefix prefixes every environment variable the agent reads.
	EnvPrefix = ProductShortName + "_"

	// MetricNamespace and MetricSubsystem prefix every Prometheus metric this
	// binary exports, e.g. "vfm_agent_leader" (PLAN.md §13).
	MetricNamespace = ProductSlug
	MetricSubsystem = "agent"

	// DefaultLeaseName is the name of the Lease used for leader election in
	// AgentNamespace (PLAN.md §3.2, §12.2).
	DefaultLeaseName = ComponentName

	// DefaultCredentialsSecret holds the agent's key, certificate and the
	// control-plane CA in AgentNamespace (PLAN.md §5.1 step 3).
	DefaultCredentialsSecret = ComponentName + "-credentials"
)
