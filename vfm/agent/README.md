# vfm-agent

The Velero Fleet Manager in-cluster agent. One agent runs in every managed
cluster, dials **out** to the control plane, and executes typed commands by
creating or patching Velero custom resources (PLAN.md §1.1 P1/P3, §3).

Module path: `github.com/shubhambatra/velero-fe/vfm/agent`.

> **Status — M0 day 3 skeleton.** This module was written on a machine without
> a Go toolchain, so it has **not been compiled, vetted or tested yet**, and no
> `go.sum` is committed. Run the commands under
> [Building and testing](#building-and-testing) once; `go mod tidy` resolves the
> indirect requirements and writes `go.sum`.

## What the binary does today

| Area | Behaviour |
|---|---|
| Configuration | Environment variables, overridden by flags, validated at startup. Startup fails once and names **every** offending setting, by variable and by flag. |
| Logging | `log/slog` JSON (PLAN.md §4.1) with fixed `service`, `version`, `instance`, `cluster_id` and `cluster_name` fields on every line. Text output is accepted only together with `-dev`. |
| Probes | `/healthz` (liveness, no dependencies), `/readyz` (Kubernetes API reachability plus leadership), `/metrics` (Prometheus). |
| Kubernetes client | In-cluster by default, from a kubeconfig with `-dev`, rate-limited and with an explicit per-request timeout. |
| Leader election | A `coordination.k8s.io` Lease in the agent namespace. Only the leader runs the task; losing the Lease cancels it and the process exits cleanly so the standby takes over (PLAN.md §3.2). |
| Shutdown | SIGTERM/SIGINT stop the leader task, then the Lease is released, then the probe listeners drain — all inside `-shutdown-timeout`. |

**The leader task itself is deliberately empty.** It logs and ticks. The gRPC
connection manager is M2 day 12 and is marked as a seam in
`cmd/agent/main.go`; there is no stub pretending to be a connection
(PLAN.md §0 rule 7).

## Layout

```
cmd/agent/main.go        wiring: config → logger → kube client → health → election
internal/config          settings, validation, product naming, safe logging
internal/health          /healthz, /readyz, /metrics and their HTTP servers
internal/kube            client construction (in-cluster and kubeconfig) + API probe
internal/leader          Lease-based leader election around a run(ctx) task
```

`internal/config/product.go` is the **only** place in this module that spells
the product name, the `vfm` slug, the `vfm-system` namespace, the `vfm.io/`
label domain and the metric prefix. It mirrors
`vfm/packages/shared/src/product.ts`; change the two together.

## Configuration

Every setting has an environment variable and a flag. Flags win. An empty
environment variable counts as "explicitly cleared", not "unset".

| Environment variable | Flag | Default | Notes |
|---|---|---|---|
| `VFM_CONTROL_PLANE_ADDRESS` | `-control-plane-address` | — | **Required.** `host:port` or an `https://` URL. Plaintext schemes and URLs with embedded credentials are rejected (PLAN.md §12.1). |
| `VFM_CLUSTER_ID` | `-cluster-id` | empty | UUID issued by the control plane at enrollment (M2 day 11). |
| `VFM_CLUSTER_NAME` | `-cluster-name` | empty | Log label only. |
| `VFM_INSTANCE_ID` | `-instance-id` | hostname | Leader-election identity; set it from the pod name via the downward API. |
| `VFM_NAMESPACE` | `-namespace` | `vfm-system` | Holds the Lease, and from M2 the agent's Secret and idempotency ConfigMap. |
| `VFM_KUBECONFIG` | `-kubeconfig` | empty | Only honoured with `-dev`. |
| `VFM_DEV` | `-dev` | `false` | Run out-of-cluster against a kubeconfig (PLAN.md §14.1). |
| `VFM_HEALTH_ADDR` | `-health-addr` | `:8081` | `/healthz`, `/readyz`. |
| `VFM_METRICS_ADDR` | `-metrics-addr` | `:9090` | `/metrics`. Set equal to the health address to share one listener. |
| `VFM_LOG_LEVEL` | `-log-level` | `info` | `debug`, `info`, `warn`, `error`. |
| `VFM_LOG_FORMAT` | `-log-format` | `json` | `text` requires `-dev`. |
| `VFM_HEARTBEAT_INTERVAL` | `-heartbeat-interval` | `15s` | PLAN.md §5.2. Used by the stream from M2 day 12. |
| `VFM_LEADER_ELECTION` | `-leader-election` | `true` | Disable only for a single-replica dev run. |
| `VFM_LEASE_NAME` | `-lease-name` | `vfm-agent` | Lease object name. |
| `VFM_LEASE_DURATION` | `-lease-duration` | `15s` | Must exceed the renew deadline. |
| `VFM_LEASE_RENEW_DEADLINE` | `-lease-renew-deadline` | `10s` | Must exceed the retry period × 1.2. |
| `VFM_LEASE_RETRY_PERIOD` | `-lease-retry-period` | `2s` | |
| `VFM_READY_REQUIRES_LEADERSHIP` | `-ready-requires-leadership` | `false` | See below. |
| `VFM_SHUTDOWN_TIMEOUT` | `-shutdown-timeout` | `20s` | Bounds graceful shutdown. |
| `VFM_KUBE_QPS` | `-kube-qps` | `20` | Client-side rate limit. |
| `VFM_KUBE_BURST` | `-kube-burst` | `30` | |
| `VFM_KUBE_TIMEOUT` | `-kube-timeout` | `30s` | Per API request; readiness probes use at most 5s. |

### Safe logging

No configured value that could be sensitive is ever logged or echoed in an
error (PLAN.md §12.1):

- startup errors name the **variable and flag only**, never the value — the
  standard library's parse errors are discarded because they quote it;
- the control-plane address is reduced to scheme, host and port, so userinfo,
  path and query (a bootstrap token, for instance) cannot leak;
- the kubeconfig path is reported as present/absent, not as a path;
- `Config` implements `slog.LogValuer`, so logging the whole config is safe by
  construction rather than by remembering to be careful.

### Readiness and leadership

`/readyz` always reports leadership in its body (`"leader": true|false`,
`checks.leadership`) and as the `vfm_agent_leader` gauge, but by default
leadership does **not** gate the status code. With two replicas only one can
ever lead (PLAN.md §3.2), and a permanently unready standby stalls Deployment
rollouts. Set `-ready-requires-leadership` if you want the standby marked
unready anyway.

`/healthz` never touches the Kubernetes API, on purpose: a liveness probe that
failed during an API-server hiccup would restart every agent in the fleet at
once.

## Metrics

`vfm_agent_leader` (1 while holding the Lease), `vfm_agent_build_info`
(version label), plus the standard Go runtime and process collectors, on a
private registry. The command, stream and inventory metrics of PLAN.md §13
arrive with the features that produce them.

## RBAC

The agent's permissions are specified in **PLAN.md §12.2** and are not restated
here — the Helm chart in M2 day 15 renders exactly that list, and a test diffs
the rendered rules against it (PLAN.md §17).

Of that list, only two things are exercised by this skeleton:

- the **Lease** in the agent namespace, for leader election;
- `/livez` on the API server, used by `/readyz`. That is a non-resource URL
  served to every authenticated client by Kubernetes' default
  `system:public-info-viewer` ClusterRole, so it needs no extra rule. A cluster
  that has removed that default binding must grant `get` on the non-resource
  URL explicitly.

## Building and testing

Requires Go 1.26 or newer (toolchain pinned to 1.27.2 — DECISIONS.md ADR-004).
From this directory:

```sh
go mod tidy          # required once: resolves indirect deps and writes go.sum
go build ./...
go test ./...
golangci-lint run ./...   # config: vfm/.golangci.yml
```

Or from the repository's `vfm/` directory: `make test-go`, `make lint-go`,
`make build`.

Run it locally against a kind cluster from `make dev-up`:

```sh
go run ./cmd/agent \
  -dev \
  -control-plane-address=https://localhost:8443 \
  -log-format=text \
  -leader-election=false
```

Then `curl -s localhost:8081/readyz` and `curl -s localhost:9090/metrics`.

Unit tests cover configuration parsing, precedence and validation, the safe
logging guarantees, the probe handlers, and the leader-election handover
ordering. They need no cluster and no network. The election against a real API
server is covered by the envtest suite that arrives with the connection manager
(PLAN.md §15).

## What lands next

| Milestone | Adds |
|---|---|
| M2 day 12 | Enrollment, key/cert in a Secret, mTLS `Connect`, `Hello`, heartbeats, reconnect with backoff — replacing the seam in `leaderTask`. |
| M2 day 14 | Command dispatcher, allowlist, agent-side policy (PLAN.md §5.5), idempotency cache. |
| M2 day 15 | Helm chart with the §12.2 RBAC, policy ConfigMap, PDB, securityContext. |
| M3 day 16 | Velero informers and inventory sync. Velero API types come from `github.com/vmware-tanzu/velero/pkg/apis/velero/v1` — the module path is unchanged at v1.18.4 even though the repository moved (DECISIONS.md ADR-002) — together with `sigs.k8s.io/controller-runtime`. |
| M3 day 20 | `DownloadRequest` fetch and streaming. |
| M5 day 28/30 | Core inventory and live log sessions, including the limits in PLAN.md §5.6. |
