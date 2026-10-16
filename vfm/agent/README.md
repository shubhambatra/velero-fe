# vfm-agent

The Velero Fleet Manager in-cluster agent. One agent runs in every managed
cluster, dials **out** to the control plane, and executes typed commands by
creating or patching Velero custom resources (PLAN.md §1.1 P1/P3, §3).

Module path: `github.com/shubhambatra/velero-fe/vfm/agent`.

> **Status — M2 day 15.** The agent compiles, vets, passes its tests, `golangci-lint`
> and `govulncheck`, and runs as a container. It enrols with a control plane,
> holds an mTLS stream open, and executes one command, `RefreshServerStatus`.
> It does not yet sync Velero inventory (M3) or run backups and restores (M4).
> Everything below that says "from M2" is now real; `DECISIONS.md` ADR-017 and
> ADR-019 record how.

## What the binary does

| Area            | Behaviour                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration   | Environment variables, overridden by flags, validated at startup. Startup fails once and names **every** offending setting, by variable and by flag.                                                                               |
| Logging         | `log/slog` JSON (PLAN.md §4.1) with fixed `service`, `version`, `instance`, `cluster_id` and `cluster_name` fields on every line.                                                                                                  |
| Probes          | `/healthz` (liveness, no dependencies), `/readyz` (Kubernetes API reachability plus leadership), `/metrics` (Prometheus).                                                                                                          |
| Leader election | A `coordination.k8s.io` Lease in the agent namespace. Only the leader dials the control plane; losing the Lease cancels the task and the process exits cleanly so the standby takes over (PLAN.md §3.2).                           |
| Enrollment      | On first start: an ECDSA P-256 key generated in the cluster, a CSR, the `kube-system` UID as fingerprint, the bootstrap token. The identity is kept in a Secret. The control plane is pinned to the CA in `controlPlane.caBundle`. |
| Stream          | mTLS `Connect`, `Hello` (version, Kubernetes version, policy), heartbeats, reconnect with exponential backoff and jitter, certificate renewal at two thirds of its lifetime, graceful half-close on shutdown.                      |
| Commands        | A typed allowlist, the owner's policy, an idempotency cache (10 000 commands, persisted to a ConfigMap), deadlines and cancellation. Anything without a handler is refused with a typed error rather than ignored.                 |
| Shutdown        | SIGTERM/SIGINT stop the leader task (running commands are cancelled and report), then the Lease is released, then the probe listeners drain — all inside `-shutdown-timeout`.                                                      |

## Layout

```
cmd/agent/main.go        wiring: config → logger → kube client → health → election → leader task
internal/config          settings, validation, product naming, safe logging
internal/health          /healthz, /readyz, /metrics and their HTTP servers
internal/kube            client construction (typed and dynamic) + API probe
internal/leader          Lease-based leader election around a run(ctx) task
internal/identity        key, CSR, parsed identity, Secret-backed store
internal/gateway         enrollment, the mTLS stream, heartbeats, backoff, renewal
internal/policy          the owner's agent-side policy (PLAN.md §5.5)
internal/dispatch        allowlist, policy gate, idempotency cache, cancellation
internal/velero          operations on Velero's resources (RefreshServerStatus)
internal/pb              generated protobuf/gRPC code (proto/ at the repo root)
test/chart               renders the Helm chart and diffs its RBAC against PLAN.md §12.2
Dockerfile               distroless, non-root image
```

The Helm chart is `vfm/deploy/helm/vfm-agent`.

`internal/config/product.go` is the **only** place in this module that spells
the product name, the `vfm` slug, the `vfm-system` namespace, the `vfm.io/`
label domain and the metric prefix. It mirrors
`vfm/packages/shared/src/product.ts`; change the two together.

## Configuration

Every setting has an environment variable and a flag. Flags win. An empty
environment variable counts as "explicitly cleared", not "unset".

| Environment variable                 | Flag                         | Default                 | Notes                                                                                                                              |
| ------------------------------------ | ---------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `VFM_CONTROL_PLANE_ADDRESS`          | `-control-plane-address`     | —                       | **Required.** `host:port` or an `https://` URL. Plaintext schemes and URLs with embedded credentials are rejected (PLAN.md §12.1). |
| `VFM_CONTROL_PLANE_CA_FILE`          | `-control-plane-ca-file`     | empty                   | PEM CA the agent pins the control plane to until it has enrolled.                                                                  |
| `VFM_SERVER_NAME`                    | `-server-name`               | host                    | TLS name to verify, if it differs from the host in the address.                                                                    |
| `VFM_CREDENTIALS_SECRET`             | `-credentials-secret`        | `vfm-agent-credentials` | Secret holding the agent's key, certificate and CA.                                                                                |
| `VFM_ENROLLMENT_TOKEN`               | **none**                     | empty                   | One-time token. **Environment only** — a flag would sit in the process list. Never logged.                                         |
| `VFM_POLICY_CONFIGMAP`               | `-policy-configmap`          | `vfm-agent-policy`      | The owner's policy (PLAN.md §5.5). Read-only for the agent; reloaded every 30 s.                                                   |
| `VFM_STATE_CONFIGMAP`                | `-state-configmap`           | `vfm-agent-state`       | Persisted executed-command cache.                                                                                                  |
| `VFM_VELERO_NAMESPACE`               | `-velero-namespace`          | `velero`                | Where Velero runs and where the agent creates its requests.                                                                        |
| `VFM_CHART_VERSION`, `VFM_IMAGE_TAG` | —                            | empty                   | Set by the chart; reported in `Hello` for "agent update available".                                                                |
| `VFM_CLUSTER_ID`                     | `-cluster-id`                | empty                   | Informational; the cluster id comes from the certificate.                                                                          |
| `VFM_CLUSTER_NAME`                   | `-cluster-name`              | empty                   | Log label only.                                                                                                                    |
| `VFM_INSTANCE_ID`                    | `-instance-id`               | hostname                | Leader-election identity; set it from the pod name via the downward API.                                                           |
| `VFM_NAMESPACE`                      | `-namespace`                 | `vfm-system`            | Holds the Lease, and from M2 the agent's Secret and idempotency ConfigMap.                                                         |
| `VFM_KUBECONFIG`                     | `-kubeconfig`                | empty                   | Only honoured with `-dev`.                                                                                                         |
| `VFM_DEV`                            | `-dev`                       | `false`                 | Run out-of-cluster against a kubeconfig (PLAN.md §14.1).                                                                           |
| `VFM_HEALTH_ADDR`                    | `-health-addr`               | `:8081`                 | `/healthz`, `/readyz`.                                                                                                             |
| `VFM_METRICS_ADDR`                   | `-metrics-addr`              | `:9090`                 | `/metrics`. Set equal to the health address to share one listener.                                                                 |
| `VFM_LOG_LEVEL`                      | `-log-level`                 | `info`                  | `debug`, `info`, `warn`, `error`.                                                                                                  |
| `VFM_LOG_FORMAT`                     | `-log-format`                | `json`                  | `text` requires `-dev`.                                                                                                            |
| `VFM_HEARTBEAT_INTERVAL`             | `-heartbeat-interval`        | `15s`                   | PLAN.md §5.2. Used by the stream from M2 day 12.                                                                                   |
| `VFM_LEADER_ELECTION`                | `-leader-election`           | `true`                  | Disable only for a single-replica dev run.                                                                                         |
| `VFM_LEASE_NAME`                     | `-lease-name`                | `vfm-agent`             | Lease object name.                                                                                                                 |
| `VFM_LEASE_DURATION`                 | `-lease-duration`            | `15s`                   | Must exceed the renew deadline.                                                                                                    |
| `VFM_LEASE_RENEW_DEADLINE`           | `-lease-renew-deadline`      | `10s`                   | Must exceed the retry period × 1.2.                                                                                                |
| `VFM_LEASE_RETRY_PERIOD`             | `-lease-retry-period`        | `2s`                    |                                                                                                                                    |
| `VFM_READY_REQUIRES_LEADERSHIP`      | `-ready-requires-leadership` | `false`                 | See below.                                                                                                                         |
| `VFM_SHUTDOWN_TIMEOUT`               | `-shutdown-timeout`          | `20s`                   | Bounds graceful shutdown.                                                                                                          |
| `VFM_KUBE_QPS`                       | `-kube-qps`                  | `20`                    | Client-side rate limit.                                                                                                            |
| `VFM_KUBE_BURST`                     | `-kube-burst`                | `30`                    |                                                                                                                                    |
| `VFM_KUBE_TIMEOUT`                   | `-kube-timeout`              | `30s`                   | Per API request; readiness probes use at most 5s.                                                                                  |

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

The agent's permissions are specified in **PLAN.md §12.2** and rendered by the
chart in `vfm/deploy/helm/vfm-agent/templates/rbac.yaml`. `test/chart` renders
the chart and diffs the rules against §12.2 written out independently in the
test, so granting more (or less) than the plan fails CI. It also checks there
is no wildcard, no `exec`, and no cluster-wide Secret access.

Two grants deserve a note: Secret `create` cannot be limited by name (the name
is not known to the authoriser at create time), so Secrets are scoped by
namespace — the Velero namespace, and the agent's own namespace where `get` and
`update` _are_ limited to the one credentials Secret. And `/livez`, used by
`/readyz`, is a non-resource URL served to every authenticated client by
Kubernetes' default `system:public-info-viewer` ClusterRole; a cluster that has
removed that default binding must grant `get` on it explicitly.

## Building and testing

Requires Go 1.26 or newer (toolchain pinned to 1.27.2 — DECISIONS.md ADR-004).
From this directory:

```sh
go build ./...
go vet ./...
go test ./...            # test/chart needs `helm`; set VFM_REQUIRE_HELM=1 to fail instead of skip
golangci-lint run ./...  # config: vfm/.golangci.yml
govulncheck ./...
docker build -t vfm-agent:local --build-arg VERSION=local .
```

`-race` needs cgo (a C compiler); CI runs it.

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
logging guarantees, the probe handlers, the leader-election handover ordering,
the identity and Secret store, the backoff, the policy rules, the dispatcher and
its idempotency cache, the Velero handler against a fake dynamic client, and the
whole agent path (manager → dispatcher → result) against an in-process control
plane over real gRPC and TLS. They need no cluster and no network. Not covered
here: the election and the Secret/ConfigMap stores against a real API server
(they use fake clientsets), which needs the kind clusters (`B-2` in
`NEXT_STEPS.md`).

## What lands next

| Milestone    | Adds                                                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M3 day 16    | Velero informers and inventory sync. Velero API types come from `github.com/vmware-tanzu/velero/pkg/apis/velero/v1` — the module path is unchanged at v1.18.4 even though the repository moved (DECISIONS.md ADR-002) — together with `sigs.k8s.io/controller-runtime`. |
| M3 day 20    | `DownloadRequest` fetch and streaming.                                                                                                                                                                                                                                  |
| M4           | Backup, restore, schedule and storage-location commands, each registered on the dispatcher with its own validation.                                                                                                                                                     |
| M5 day 28/30 | Core inventory and live log sessions, including the limits in PLAN.md §5.6.                                                                                                                                                                                             |
