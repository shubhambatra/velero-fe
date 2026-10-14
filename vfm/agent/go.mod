module github.com/shubhambatra/velero-fe/vfm/agent

// The language floor is set by the dependencies below: k8s.io/client-go v0.36.5
// and k8s.io/apimachinery v0.36.5 both declare `go 1.26.0`. That also satisfies
// Velero v1.18.4's own floor of go 1.25.8 (DECISIONS.md ADR-002), which matters
// from M3 day 16 when the Velero API types are imported.
go 1.26.0

toolchain go1.27.2

require (
	github.com/prometheus/client_golang v1.24.1
	k8s.io/apimachinery v0.36.5
	k8s.io/client-go v0.36.5
)

// NOTE: no go.sum is committed yet and the indirect requirements below are
// intentionally absent — run `go mod tidy` once (see README.md) to resolve and
// record them. Deliberately NOT yet required:
//
//   - sigs.k8s.io/controller-runtime — informers/manager land in M3 day 16.
//     Use v0.24.x, which pins k8s.io/client-go v0.36.x (same minor as above).
//   - github.com/vmware-tanzu/velero — Velero API types, M3 day 16. The module
//     path is unchanged at v1.18.4 even though the repo moved to velero-io
//     (DECISIONS.md ADR-002).
//   - google.golang.org/grpc — the agent gateway client, M2 day 12.
