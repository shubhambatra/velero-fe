# Velero Fleet Manager — Build Plan

> **This document is the build specification.** Claude Code reads it top to bottom, then works through the milestones in Section 16 in order.
> Working name: **Velero Fleet Manager (VFM)**. The name can be changed later. Keep it in one constant per package so a rename is trivial.

---

## 0. Rules for Claude Code (read first, follow always)

1. **Milestone gating.** Work strictly in the order of Section 16. Every milestone has *Exit Criteria*. Do not start the next milestone until every criterion passes. If a criterion cannot pass, stop and report why.
2. **Progress log.** Keep `docs/PROGRESS.md` updated at the end of every working day/session. For each entry, record: date, milestone/day, what was completed, test status, what is next, and blockers. A new session always starts by reading `docs/PROGRESS.md` and this plan.
3. **Decision log.** Any deviation from this plan, any new dependency, and any contract change goes into `docs/DECISIONS.md` as a short ADR: context, decision, consequences. Never diverge silently.
4. **Never invent Velero fields.** Before writing code that touches a Velero object, read the Go type definitions from the **pinned Velero release** (Section 4.4). If this plan contradicts the real API, the real API wins. Log the correction in `DECISIONS.md`.
5. **Contracts are the source of truth.** `proto/` (agent protocol), `server/prisma/schema.prisma` (DB), and `server/openapi.yaml` (REST) are the contracts. Change them deliberately, regenerate code, and log the change.
6. **Tests are part of the feature.** No feature is done without tests. `make test` must be green at the end of every day. `make e2e` must be green at the end of every milestone.
7. **No fake completeness.** Do not leave stubbed handlers, mocked responses, or `TODO` code paths and report them as done. If something is deferred, list it in `PROGRESS.md` under "Deferred".
8. **Security defaults are not optional.** Section 12 applies from day 1, not in a hardening phase.
9. **HUMAN CHECKPOINT.** Where a day says `⛔ HUMAN CHECKPOINT`, stop. Write a summary of what to verify and how, then wait for the human to confirm before continuing.
10. **Ask instead of guess** on anything in Section 18 (Open Questions) if it blocks work. Otherwise use the default stated in this plan.

---

## 1. Product summary

A central web platform that manages **Velero** across **many Kubernetes clusters** from one place.

- A small **agent** runs inside each cluster. It connects **outbound** to the central **control plane** over a persistent, mutually authenticated stream.
- The control plane sends **typed commands** (create backup, restore, schedule, etc.). The agent executes them by creating or patching Velero custom resources. It then streams back status, Velero logs, and cluster health.
- The control plane handles **users, organizations, teams, RBAC, audit, alerts, and reports**.
- The web UI gives every Velero CLI capability as a GUI, scoped to what each user is allowed to see and do.

### 1.1 Core principles (do not violate)

| # | Principle | Why |
|---|-----------|-----|
| P1 | **Agent dials out only.** The control plane never needs network access into a cluster. | Clusters sit behind firewalls/NAT. This is how Rancher, Argo CD agent mode, and similar systems work. |
| P2 | **Backup data never passes through VFM.** Velero writes backups straight to object storage. VFM moves only metadata, status, logs, and commands. | Moving terabytes through the platform would make it a bottleneck and a data-breach target. |
| P3 | **The agent is a typed command executor, not a remote shell.** It accepts only commands defined in `proto/`. No generic kubectl, no exec, no arbitrary YAML apply. | A compromised control plane must not mean arbitrary code execution in every cluster. |
| P4 | **Least privilege everywhere.** Agent RBAC is minimal (Section 12.2). Users get only the permissions their role grants on specific clusters/namespaces. | Restore can overwrite anything in a cluster. VFM is, in effect, cluster-admin by proxy. |
| P5 | **Everything is audited.** Every state-changing action records who, what, where, when, and the result. | Backup/restore systems are audit-relevant in every regulated company. |
| P6 | **Air-gap capable.** No runtime calls to the public internet. No CDN assets. All images and charts can be mirrored. | Enterprise and on-prem buyers require this. |

---

## 2. Scope

### 2.1 In scope for v1

- Multi-cluster agent enrollment, health, and live connection status.
- All Velero day-2 operations (full matrix in Section 6): backups, restores, schedules, backup storage locations, volume snapshot locations, backup repositories, logs, describe/details, delete, download of results.
- Cluster live view: nodes, namespaces, pods, containers (status, restarts, conditions), recent events, PVCs.
- On-demand **live log tail** of any container, Velero server, and Velero node-agent pods. This streams through the agent and is **not stored**.
- Velero log retrieval for each backup/restore (via `DownloadRequest`).
- Organizations, teams, users, roles, per-cluster and per-namespace permissions.
- Local login (email + password + TOTP MFA) and OIDC SSO.
- API tokens for automation.
- Audit log (UI + export).
- Alerts: failed/partially-failed backup, missed schedule, agent offline, BSL unavailable. Channels: email, generic webhook, Slack-compatible webhook.
- Reports: backup success rate, last successful backup per cluster/namespace, RPO compliance. Exportable as CSV.
- Helm charts for the control plane and the agent. Air-gap install docs.
- Platform metrics endpoint (Prometheus) and structured JSON logs.

### 2.2 Explicitly out of scope for v1 (do not build)

- Installing, upgrading, or uninstalling Velero itself (`velero install`, `velero uninstall`), and adding/removing plugins (`velero plugin add/remove`). Velero lifecycle is managed by the customer's Helm/GitOps. VFM only **detects and reports** the Velero version and plugins.
- Storing container logs centrally, log search, or metrics time-series. VFM is not an observability platform. Link out to the customer's Grafana/Loki if configured (a URL template per cluster).
- `velero debug` bundles (candidate for v1.1).
- Cross-cluster restore orchestration (backup in A, restore in B). The data model must not prevent it. Candidate for v1.1.
- Billing, SaaS multi-region, and LDAP (v1.1; OIDC covers most LDAP-backed IdPs).

---

## 3. Architecture

```
                          ┌───────────────────────────────────────────────┐
  Browser (React SPA) ───►│  CONTROL PLANE (NestJS, N replicas)           │
     HTTPS + SSE          │   ├─ REST API (/api/v1)  + SSE (/api/v1/stream)│
                          │   ├─ AuthN (local+TOTP, OIDC) / AuthZ (RBAC)  │
                          │   ├─ Agent Gateway (gRPC, mTLS, port 8443)    │◄─────────┐
                          │   ├─ Command service (queue, lifecycle)       │          │
                          │   ├─ Alerts / Reports workers (BullMQ)        │          │
                          │   └─ Internal CA (agent cert issuing)         │          │
                          └───────┬──────────────────────┬────────────────┘          │
                                  │                      │                           │
                           PostgreSQL 16           Redis/Valkey 7                    │
                       (state, audit, inventory)  (pub/sub between replicas,         │
                                                   job queue, rate limits,           │
                                                   agent→replica routing)            │
                                                                                     │
   ┌────────────── Cluster A ──────────────┐   ┌────────────── Cluster B ───────┐   │
   │  vfm-agent (Go, 1 replica + leader    │   │  vfm-agent                     │   │
   │  election, ns: vfm-system)            │───┼────────────────────────────────┼───┘
   │    ├─ outbound gRPC bidi stream (mTLS)│   │  (same)                        │  outbound only
   │    ├─ informers: velero.io/*, nodes,  │   └────────────────────────────────┘
   │    │  pods, events, pvcs, namespaces  │
   │    ├─ command executor (allowlist)    │
   │    └─ log streamer (on demand)        │
   │  Velero server + node-agent (ns velero)│──► Object storage (S3/GCS/Azure/MinIO)
   └───────────────────────────────────────┘     (backup data goes here directly)
```

### 3.1 Request flow example: "Create backup" from the UI

1. User submits the form. The browser calls `POST /api/v1/clusters/{id}/backups`.
2. The control plane checks authN → RBAC (`backup:create` on cluster, and on every namespace in `includedNamespaces`) → validates the payload.
3. It writes a `commands` row (`QUEUED`) and an `audit_events` row in **one transaction**.
4. It publishes to Redis channel `agent:{clusterId}`. The replica holding that agent's stream picks it up and sends `Command{id, CreateBackup{...}}`. Status becomes `SENT`.
5. The agent validates (allowlist, schema, local policy), creates the `Backup` CR, and replies `CommandAck` → `RUNNING`, then `CommandResult` → `SUCCEEDED` (the CR was created).
6. The Velero informer in the agent sees the `Backup` status change (`InProgress` → `Completed`/`PartiallyFailed`/`Failed`). It sends `ResourceEvent`s. The control plane updates `velero_resources` and pushes them over SSE to subscribed browsers.
7. On a terminal phase, the alert worker evaluates rules.

**Important:** "command succeeded" means the CR was created. "Backup succeeded" is the Velero phase. The UI must show both clearly and never conflate them.

### 3.2 High availability

- Control plane: stateless replicas behind a load balancer. The gRPC gateway needs L4 passthrough or an L7 balancer that supports HTTP/2 + long streams. Document both options.
- Each agent holds one stream to one replica. The replica registers `agent:{clusterId} → replicaId` in Redis with a TTL refreshed by heartbeats. Commands are routed via Redis pub/sub.
- If a replica dies, the agent reconnects (exponential backoff with jitter: 1s → 60s max). Undelivered `QUEUED`/`SENT` commands are re-sent. The agent dedupes them by command ID (Section 5.4).
- Agent: Deployment with 2 replicas + Kubernetes Lease leader election. Only the leader connects and executes.

---

## 4. Tech stack (pinned choices)

### 4.1 Agent — Go

- Go (latest stable at project start; record the exact version in `go.mod` and `DECISIONS.md`).
- `sigs.k8s.io/controller-runtime` + `k8s.io/client-go` (informers, leader election).
- **Velero API types imported from the pinned Velero release** (`pkg/apis/velero/v1`, `v2alpha1`). Verify the current Go module path. Velero moved into the CNCF in 2026, and the repo/module path may have changed from `github.com/vmware-tanzu/velero`. Use whatever the pinned release's `go.mod` declares.
- `google.golang.org/grpc`, protobuf via `buf`.
- `log/slog` (JSON), `prometheus/client_golang`.
- Distroless static image, non-root, read-only root FS.

**Why Go for the agent:** the Kubernetes and Velero ecosystems are Go-native. Velero's own types, informers, and leader election come for free, and the binary is small with low memory.

### 4.2 Control plane — TypeScript / NestJS

- Node.js 22 LTS, NestJS (latest stable major), TypeScript `strict: true`.
- PostgreSQL 16 via **Prisma** (migrations committed).
- Redis/Valkey 7: `ioredis`, **BullMQ** for jobs.
- gRPC server: `@grpc/grpc-js` + `ts-proto` generated from the same `proto/`.
- Auth: `argon2` (password hashing), `otplib` (TOTP), `openid-client` (OIDC), httpOnly secure cookie sessions stored in Redis.
- Validation: `zod` (shared schemas exported for the web app via a `packages/shared` workspace).
- Logging: `pino` JSON. Metrics: `prom-client`.
- Email: `nodemailer` (SMTP, so it works air-gapped).

**Why TypeScript here:** the owner of this codebase is a senior React/TypeScript engineer and must be able to review and maintain the control plane. The agent is the only Go component, and its surface is deliberately small.

### 4.3 Web — React

- React 19 + TypeScript + Vite.
- TanStack Router, TanStack Query, `react-hook-form` + `zod`, Tailwind + shadcn/ui, `recharts`.
- Log viewer: virtualized list (`@tanstack/react-virtual`) with ANSI color support, follow mode, pause, search-in-buffer, and a 50k-line ring buffer.
- Realtime: **Server-Sent Events** (proxy-friendly, auto-reconnect) for resource events and log tails.
- No external fonts/CDNs. Everything is bundled (P6).

### 4.4 Velero compatibility

- **Pin** the newest stable Velero release at project start as `VELERO_PRIMARY`. At the time of writing, the 1.18.x line is current. Verify on the Velero releases page and record the result.
- Support `VELERO_PRIMARY` and the two previous minor versions. The agent detects the server version via `ServerStatusRequest` and reports it. The UI hides or disables features the detected version does not support. Keep a capability map in `agent/internal/velero/capabilities.go`.
- E2E tests run against `VELERO_PRIMARY` and the oldest supported minor.

### 4.5 Tooling

- Monorepo with `pnpm` workspaces (TS) + Go module in `agent/`.
- `buf` for proto lint/breaking-change detection/codegen.
- `Taskfile.yml` or `Makefile` with targets: `setup`, `gen`, `lint`, `test`, `e2e`, `dev-up`, `dev-down`, `build`, `helm-lint`.
- GitHub Actions CI: lint, unit tests, buf breaking check, build images, e2e on kind.

---

## 5. Agent ↔ control plane protocol

### 5.1 Enrollment

1. An org admin clicks **Add cluster** in the UI and names it. The control plane creates a `clusters` row (`PENDING`) and a **one-time bootstrap token**: random 32 bytes, stored hashed, valid for 24h, bound to the cluster ID.
2. The UI shows a copy-paste `helm install` command with the control-plane URL, the CA bundle, and the token.
3. On first start, the agent generates an ECDSA P-256 keypair (the private key never leaves the cluster; stored in a Secret in `vfm-system`). It calls the unary RPC `Enroll(token, CSR, clusterFingerprint)`.
   - `clusterFingerprint` = UID of the `kube-system` namespace. This is used to detect the same agent being installed into a different cluster.
4. The control plane validates and burns the token, then signs a client certificate from its **internal CA**: 7-day validity, SAN = `spiffe://vfm/cluster/{clusterId}`. The cluster becomes `ENROLLED`.
5. The agent stores the cert and opens the stream with mTLS. It renews the cert at 2/3 of its lifetime via the `RenewCertificate` RPC, authenticated by the current cert.
6. **Revocation:** deleting/disabling a cluster in the UI adds the cert serial to a deny-list checked on every connect. Any open stream is closed immediately.

### 5.2 Stream

```protobuf
service AgentGateway {
  rpc Enroll(EnrollRequest) returns (EnrollResponse);              // bootstrap-token auth
  rpc RenewCertificate(RenewRequest) returns (RenewResponse);      // mTLS auth
  rpc Connect(stream AgentMessage) returns (stream ServerMessage);  // mTLS auth
}

message AgentMessage {
  string message_id = 1;            // UUIDv7
  oneof payload {
    Hello hello = 10;               // first message: agent version, protocol version, k8s version,
                                    // velero version + plugins, capabilities, fingerprint
    Heartbeat heartbeat = 11;       // every 15s
    CommandAck ack = 12;
    CommandResult result = 13;
    InventorySnapshot snapshot = 14;      // full state, chunked
    ResourceEvents events = 15;           // batched deltas
    LogChunk log_chunk = 16;              // for an active log session or a DownloadRequest fetch
    LogSessionEnded log_ended = 17;
  }
}

message ServerMessage {
  string message_id = 1;
  oneof payload {
    HelloAck hello_ack = 10;        // accepted protocol version, server time, config (intervals, limits)
    Command command = 11;
    CancelCommand cancel = 12;
    StartLogSession start_logs = 13;
    StopLogSession stop_logs = 14;
    RequestResync resync = 15;
  }
}

message Command {
  string command_id = 1;            // UUIDv7, idempotency key
  google.protobuf.Timestamp deadline = 2;
  string requested_by = 3;          // user id, for agent-side audit logging
  oneof op {
    CreateBackup create_backup = 10;
    DeleteBackup delete_backup = 11;
    CreateRestore create_restore = 12;
    DeleteRestore delete_restore = 13;
    CreateSchedule create_schedule = 14;
    UpdateSchedule update_schedule = 15;
    SetSchedulePaused set_schedule_paused = 16;
    DeleteSchedule delete_schedule = 17;
    TriggerScheduleNow trigger_schedule = 18;      // backup create --from-schedule
    UpsertBackupStorageLocation upsert_bsl = 19;   // includes optional credential secret
    SetDefaultBackupStorageLocation set_default_bsl = 20;
    DeleteBackupStorageLocation delete_bsl = 21;
    UpsertVolumeSnapshotLocation upsert_vsl = 22;
    DeleteVolumeSnapshotLocation delete_vsl = 23;
    FetchDownload fetch_download = 24;             // create DownloadRequest, fetch URL, stream back
    RefreshServerStatus refresh_status = 25;       // ServerStatusRequest
  }
}
```

Claude Code fills in all message fields from the real Velero specs. Use explicit fields, not raw YAML blobs, for everything the UI exposes. Add one escape hatch, `advanced_spec_json` on `CreateBackup`/`CreateRestore`/`CreateSchedule`. It is merged onto the generated spec, then **validated agent-side against the Velero type** (unknown fields → reject). It requires the `advanced:write` permission.

### 5.3 Inventory sync

- On connect: the agent sends a full `InventorySnapshot` in chunks of 1 MB or less with a `snapshot_id` and a sequence. The control plane replaces that cluster's inventory atomically when the last chunk arrives.
- After that: informer deltas are batched and debounced (max 2s, max 500 items per batch) as `ResourceEvents`.
- Every 10 minutes, or on `RequestResync`, the agent sends a new full snapshot (self-healing against missed deltas).
- Synced kinds: Velero `Backup`, `Restore`, `Schedule`, `BackupStorageLocation`, `VolumeSnapshotLocation`, `BackupRepository`, `PodVolumeBackup`, `PodVolumeRestore`, `DataUpload`, `DataDownload`, `DeleteBackupRequest` (as supported by the detected version), plus core `Node`, `Namespace`, `Pod` (summary only — see 7.1), `PersistentVolumeClaim`, `Event` (last 1h, warnings + Velero-related only).
- **Never sync Secrets.** For BSLs, sync only the secret name/key reference.

### 5.4 Command lifecycle

```
QUEUED ─► SENT ─► ACKED ─► RUNNING ─► SUCCEEDED
   │        │        │          └────► FAILED (error code + message)
   │        └────────┴──► (reconnect) re-SENT
   └──► CANCELLED (by user before ACK)
any non-terminal ──► TIMED_OUT (deadline passed; default 5 min, configurable per op)
```

- The agent keeps an LRU of the last 10,000 executed `command_id`s plus their results (in memory, and persisted to a ConfigMap every 30s). On a duplicate, it replies with the cached result and does not re-execute.
- Created CRs carry labels `vfm.io/command-id` and `vfm.io/requested-by`, plus the annotation `vfm.io/managed=true`. This makes created objects traceable and makes creation idempotent even after an agent restart (check for an existing object with that label before creating).
- Error codes are an enum: `INVALID_ARGUMENT`, `NOT_FOUND`, `ALREADY_EXISTS`, `FORBIDDEN_BY_AGENT_POLICY`, `UNSUPPORTED_BY_VELERO_VERSION`, `KUBE_API_ERROR`, `TIMEOUT`, `INTERNAL`.

### 5.5 Agent-side policy (defense in depth)

A `ConfigMap` `vfm-agent-policy` set by the cluster owner at Helm install time, **not** changeable from the control plane:

- `allowRestore: true|false` (default `true`)
- `restoreDeniedNamespaces: [kube-system, vfm-system, velero]` (default)
- `allowBslWrite: true|false` (default `true`)
- `allowLogStreaming: true|false` (default `true`)
- `logStreamDeniedNamespaces: []`
- `readOnly: false` — when `true`, the agent rejects all mutating commands.

The agent enforces these before executing and reports the policy in `Hello` so the UI can show disabled actions with the reason.

### 5.6 Limits

- Max gRPC message: 4 MB. Log chunks are 64 KB or less.
- Max concurrent log sessions per agent: 10 (configurable). The oldest is closed when the limit is exceeded.
- Log session hard timeout: 30 minutes. Idle timeout (no browser subscriber): 60 seconds.
- Agent buffers up to 5,000 outbound events while disconnected. On overflow it drops deltas and forces a full resync on reconnect.

### 5.7 Versioning

- `protocol_version` (integer) in `Hello`. The control plane supports the current version and the one before it. `buf breaking` runs in CI against `main`.
- The agent's Helm chart version and image tag are reported. The UI shows "agent update available" when it is behind.

---

## 6. Velero CLI coverage matrix

Claude Code must also enumerate the real subcommands from the pinned Velero source (`pkg/cmd/cli/...`). Add any missing command to this table with a decision (implement / out of scope + reason) in `DECISIONS.md`.

| Velero CLI | VFM implementation | Permission |
|---|---|---|
| `backup create` (all flags: include/exclude namespaces, resources, cluster-scoped, label/or-label selectors, TTL, storage location, snapshot locations, snapshot-volumes, default-volumes-to-fs-backup, snapshot-move-data, data-mover, item-operation-timeout, resource-policies, csi-snapshot-timeout, ordered-resources, parallel-files-upload, wait) | `CreateBackup` → `Backup` CR | `backup:create` + namespace scope |
| `backup create --from-schedule` | `TriggerScheduleNow` → `Backup` from schedule template | `backup:create` |
| `backup get` / `describe` | Inventory + `FetchDownload` for details | `backup:read` |
| `backup describe --details` | `FetchDownload` kinds: resource list, volume info, item operations, results; plus PVB/DataUpload inventory | `backup:read` |
| `backup logs` | `FetchDownload(BackupLog)` → streamed, gunzipped, rendered in the log viewer, downloadable | `backup:logs` |
| `backup download` | **Not proxied** (P2). Generate a short-lived presigned URL via `DownloadRequest(BackupContents)` and return it to the browser *only if* `backup:download` is granted and the org setting `allowBackupContentDownload` is on (default off). | `backup:download` |
| `backup delete` | `DeleteBackup` → `DeleteBackupRequest` | `backup:delete` |
| `restore create` (from-backup, from-schedule, include/exclude namespaces/resources, namespace-mappings, label selectors, restore-volumes, preserve-nodeports, existing-resource-policy, status include/exclude, item-operation-timeout, write-sparse-files, parallel-files-download, resource-modifier configmap) | `CreateRestore` → `Restore` CR | `restore:create` + **target** namespace scope (after mapping) |
| `restore get` / `describe` / `describe --details` | Inventory + `FetchDownload(RestoreResults, RestoreResourceList, ...)` | `restore:read` |
| `restore logs` | `FetchDownload(RestoreLog)` | `restore:logs` |
| `restore delete` | `DeleteRestore` | `restore:delete` |
| `schedule create` (cron, all backup-template flags, use-owner-references, paused) | `CreateSchedule` | `schedule:write` |
| `schedule get` / `describe` | Inventory | `schedule:read` |
| `schedule pause` / `unpause` | `SetSchedulePaused` | `schedule:write` |
| `schedule delete` | `DeleteSchedule` | `schedule:delete` |
| `backup-location create` / `set` / `get` / `delete` (+ `--default`, credentials, access-mode, validation-frequency) | `UpsertBackupStorageLocation`, `SetDefaultBackupStorageLocation`, `DeleteBackupStorageLocation`. Credentials: the user enters them in the UI; they are sent once in the command, **never stored by the control plane**, and written by the agent to a Secret in the Velero namespace. | `storage:write` |
| `snapshot-location create` / `set` / `get` / `delete` | `UpsertVolumeSnapshotLocation`, `DeleteVolumeSnapshotLocation` | `storage:write` |
| `repo get` | Inventory (`BackupRepository`) | `storage:read` |
| `plugin get` | `RefreshServerStatus` (`ServerStatusRequest`) → plugins list | `cluster:read` |
| `version` | `Hello` + `RefreshServerStatus` | `cluster:read` |
| `install`, `uninstall`, `plugin add/remove` | **Out of scope** (Section 2.2). Show detected version/plugins plus a docs link. | — |
| `debug` | Out of scope v1 | — |
| `client config`, `completion` | Not applicable to a GUI | — |

**UI must:** show the equivalent `velero` CLI command for every form (a "Show CLI equivalent" toggle). This is a big trust and learning feature, and it is cheap to build because the form already holds every flag.

---

## 7. Cluster status and logs

### 7.1 Live view (stored as current state only, no history)

- **Cluster:** connection status, last heartbeat, Kubernetes version, Velero version and plugins, BSL availability, agent version, agent policy.
- **Nodes:** name, ready condition, roles, kubelet version, allocatable CPU/memory, pressure conditions, taints, schedulable flag.
- **Namespaces:** name, labels, phase, and "last successful backup covering this namespace" (computed by the control plane).
- **Pods** (summary only): namespace, name, phase, ready count, restart count, node, owner kind/name, start time, per-container `{name, image, state, reason, restarts, lastTerminationReason}`. **No env vars, no specs, no annotations.** They often contain secrets.
- **PVCs:** namespace, name, status, capacity, storage class, bound PV.
- **Events:** warnings, plus anything involving velero.io objects, from the last 1 hour.

Large clusters: if the pod count exceeds 20,000, the agent sends pod summaries only for namespaces a user has opened in the last 10 minutes (the control plane sends a `WatchScope` update). Implement this as a config switch from the start. Default threshold: 20,000.

### 7.2 Live log tail (on demand, not stored)

1. The user opens a container's log view. The browser calls `POST /api/v1/clusters/{id}/log-sessions {namespace, pod, container, tailLines, sinceSeconds, previous, timestamps}`. RBAC: `logs:read` on that namespace.
2. The control plane sends `StartLogSession`. The agent calls `pods/log` with `follow=true` and streams `LogChunk`s.
3. The control plane fans the chunks out over SSE to that session's subscribers. Nothing is written to Postgres.
4. Every session start is **audited** (who viewed which container's logs, when).

### 7.3 Velero logs

- Velero server and node-agent pod logs use the same mechanism (7.2), with shortcuts in the UI.
- Per-backup/restore logs use `FetchDownload`. The agent creates a `DownloadRequest`, waits for the signed URL, downloads the gzip **from inside the cluster** (object storage is usually reachable only from there), and streams it back. These logs **may be cached** in Postgres/object storage of the control plane for 7 days (configurable) so repeat views are fast. They contain resource names, so access stays behind `backup:logs`.

---

## 8. Identity, organizations, RBAC

### 8.1 Model

```
Platform (super-admin, separate flag on user; bootstraps the first org)
└── Organization
    ├── Members (users) — one org role: Owner | Admin | Member
    ├── Teams (groups of members; OIDC group claims can map to teams)
    ├── Clusters
    │   └── Role bindings: (user or team) → role → scope
    │        scope = whole cluster | list of namespaces | namespace label selector
    ├── Notification channels, alert rules
    └── API tokens (bound to a user or a service identity; inherit/limit permissions)
```

A user can belong to multiple orgs and switches org in the UI. All data queries are **always** filtered by `org_id`. Enforce it in a Prisma middleware/extension so it cannot be forgotten. Write a test that fails if any repository query lacks org scoping.

### 8.2 Built-in roles (per cluster binding)

| Permission | Viewer | Operator | Restorer | Cluster Admin |
|---|:-:|:-:|:-:|:-:|
| `cluster:read` (inventory, status) | ✓ | ✓ | ✓ | ✓ |
| `backup:read`, `restore:read`, `schedule:read`, `storage:read` | ✓ | ✓ | ✓ | ✓ |
| `backup:logs`, `restore:logs` | | ✓ | ✓ | ✓ |
| `logs:read` (container live logs) | | ✓ | ✓ | ✓ |
| `backup:create` | | ✓ | ✓ | ✓ |
| `schedule:write` | | ✓ | | ✓ |
| `restore:create` | | | ✓ | ✓ |
| `backup:delete`, `restore:delete`, `schedule:delete` | | | | ✓ |
| `storage:write` | | | | ✓ |
| `backup:download` | | | | ✓ (and org setting on) |
| `advanced:write` | | | | ✓ |
| `cluster:manage` (rename, delete, rotate agent, edit bindings) | | | | ✓ |

Org Owner/Admin implicitly get Cluster Admin on all org clusters. Custom roles are a v1.1 item, but store roles as data (a permission array), not code, so custom roles become a UI-only change later.

**Namespace scoping rule:** for a scoped binding, a backup/restore request is allowed only if **every** included namespace (after namespace mapping, for restores) is within scope, and the request does not include cluster-scoped resources (`includeClusterResources` must be `false`). Wildcards (`*`) or empty "all namespaces" are allowed only for whole-cluster bindings. Unit-test this rule exhaustively. It is the most security-critical function in the codebase.

### 8.3 Authentication

- Local: email + password (argon2id, min 12 chars, breached-password check against a bundled top-100k list, no external calls) + TOTP MFA. MFA is **enforceable per org** (default: required for Owner/Admin).
- OIDC: per-org configuration (issuer, client ID/secret, group claim, group → team mapping, JIT user provisioning on/off). Multiple providers per org are allowed.
- Sessions: httpOnly, Secure, SameSite=Lax cookie; Redis-backed; 12h absolute, 1h idle; rotate on privilege change; "sign out everywhere".
- CSRF: double-submit token on all state-changing REST calls.
- Brute-force protection: per-IP and per-account rate limits, progressive delay, lockout notification email.
- API tokens: prefix `vfm_`, shown once, stored hashed, optional expiry, optional reduced permission set and cluster subset. Used via `Authorization: Bearer`.
- Re-authentication (password or MFA) is required within the last 5 minutes for: restore create, any delete, storage write, cluster delete, role binding changes. This is "sudo mode".

### 8.4 Optional restore approval (build in M6, behind an org setting, default off)

When `requireRestoreApproval` is on for a cluster, a restore request becomes `PENDING_APPROVAL`. Another user with `restore:create` (not the requester) must approve before the command is queued. Audit both actions.

---

## 9. Data model (PostgreSQL)

Claude Code writes the Prisma schema from this. All tables have `id` (UUIDv7), `created_at`, `updated_at`. All org-owned tables have `org_id` with an index.

- `users` (email unique, password_hash nullable, mfa_secret_encrypted, mfa_enabled, is_platform_admin, disabled_at, last_login_at)
- `organizations` (name, slug unique, settings JSONB: mfaRequired, allowBackupContentDownload, logCacheDays, requireRestoreApproval default)
- `memberships` (org_id, user_id, org_role) unique (org_id, user_id)
- `teams`, `team_members`
- `oidc_providers` (org_id, issuer, client_id, client_secret_encrypted, group_claim, mappings JSONB, jit_enabled)
- `sessions` — in Redis, not Postgres
- `api_tokens` (org_id, user_id, name, token_hash, prefix, permissions JSONB nullable, cluster_ids nullable, expires_at, last_used_at, revoked_at)
- `clusters` (org_id, name, status enum PENDING|ENROLLED|CONNECTED|DISCONNECTED|DISABLED, fingerprint, k8s_version, velero_version, velero_plugins JSONB, agent_version, protocol_version, agent_policy JSONB, capabilities JSONB, last_seen_at, labels JSONB, grafana_url_template nullable)
- `cluster_bootstrap_tokens` (cluster_id, token_hash, expires_at, used_at)
- `agent_certificates` (cluster_id, serial, not_after, revoked_at)
- `role_bindings` (org_id, cluster_id, subject_type USER|TEAM, subject_id, role, scope JSONB `{type: CLUSTER|NAMESPACES|SELECTOR, namespaces?, selector?}`)
- `commands` (org_id, cluster_id, type, payload JSONB (**redacted**: no credentials), status, error_code, error_message, requested_by, approved_by nullable, deadline, sent_at, acked_at, finished_at, result JSONB)
- `velero_resources` (org_id, cluster_id, kind, namespace, name, uid, resource_version, phase, spec JSONB, status JSONB, labels JSONB, created_by_vfm boolean, deleted_at) unique (cluster_id, kind, namespace, name). Index on (cluster_id, kind, phase) and on start/completion timestamps extracted to columns.
- `cluster_inventory` (cluster_id, kind NODE|NAMESPACE|POD|PVC|EVENT, namespace, name, data JSONB, updated_at) — current state only; replaced on snapshot.
- `log_cache` (cluster_id, resource_kind, resource_name, storage_ref or bytea gzipped, expires_at)
- `audit_events` (org_id, actor_type USER|TOKEN|SYSTEM|AGENT, actor_id, action, target_type, target_id, cluster_id, ip, user_agent, request_id, outcome SUCCESS|DENIED|FAILED, details JSONB redacted). **Append-only:** revoke UPDATE/DELETE from the app DB role, and use a separate retention job role.
- `alert_rules` (org_id, type, scope JSONB, params JSONB, channel_ids, enabled)
- `notification_channels` (org_id, type EMAIL|WEBHOOK|SLACK_WEBHOOK, config_encrypted)
- `alert_events` (rule_id, cluster_id, state FIRING|RESOLVED, fingerprint, payload, fired_at, resolved_at, last_notified_at)

**Encryption at rest for sensitive columns** (`*_encrypted`): AES-256-GCM envelope encryption. The key-encryption key comes from env/Secret (`VFM_MASTER_KEY`, 32 bytes base64) or a KMS plugin interface (v1 ships the env implementation only). Support key rotation by storing a key ID with each ciphertext.

Retention jobs (BullMQ, daily): `cluster_inventory` events older than 1h, `log_cache` past expiry, `commands` older than 180 days, `audit_events` older than the org setting (default 400 days; export before delete is an org option).

---

## 10. REST API (control plane)

- Base path `/api/v1`. JSON. OpenAPI 3.1 is generated from Nest decorators and committed as `server/openapi.yaml`. The web client types are generated from it.
- Pagination: cursor-based (`?cursor=&limit=`, max 200). Filtering and sorting via query params documented per endpoint.
- Every response includes an `X-Request-Id` header. Errors use RFC 9457 problem+json.

Endpoint groups (Claude Code designs the exact shapes):

- `/auth/*` — login, logout, MFA setup/verify, OIDC start/callback, sudo re-auth, sessions list/revoke
- `/me`, `/me/orgs`, `/me/tokens`
- `/orgs/{orgId}` — settings, members, invites, teams, OIDC providers
- `/orgs/{orgId}/clusters` — CRUD, bootstrap token (re)issue, helm command, disable, rotate agent cert
- `/clusters/{id}/role-bindings`
- `/clusters/{id}/overview` — health and summary counts
- `/clusters/{id}/{backups|restores|schedules|backup-locations|snapshot-locations|repositories}` — list/get from inventory; POST/PATCH/DELETE create commands and return `202 {commandId}`
- `/clusters/{id}/backups/{name}/{logs|details|download-url}`
- `/clusters/{id}/restores/{name}/{logs|details}`
- `/clusters/{id}/inventory/{nodes|namespaces|pods|pvcs|events}`
- `/clusters/{id}/log-sessions` (POST to start, DELETE to stop), `/log-sessions/{id}/stream` (SSE)
- `/commands/{id}` (status), `/commands?clusterId=` (history)
- `/approvals` (list/approve/reject restore requests)
- `/stream` — SSE for resource/command/cluster-status events for clusters the user can see (server-side filtered per permission)
- `/orgs/{orgId}/audit` (+ CSV export), `/orgs/{orgId}/alerts`, `/orgs/{orgId}/channels`, `/orgs/{orgId}/reports/*`
- `/healthz` (liveness), `/readyz` (DB + Redis), `/metrics` (Prometheus, separate port 9090, not exposed publicly)

---

## 11. Web UI

### 11.1 Pages

1. **Login** (local + configured SSO buttons), MFA challenge, MFA setup.
2. **Org switcher** + **Fleet overview:** cluster cards/table with connection status, Velero version, last backup result, failing schedules, BSL health; fleet-wide counts; a "needs attention" list.
3. **Cluster detail** (tabs):
   - Overview (health, versions, policy, BSLs, recent activity)
   - Backups (table with phase, start/finish, duration, expiry, items, warnings/errors; filters; bulk delete)
   - Restores
   - Schedules (next run, last run result, pause toggle, "Run now")
   - Storage (BSLs, VSLs, repositories)
   - Workloads (nodes, namespaces with backup coverage, pods → containers → live logs)
   - Events
   - Activity (commands for this cluster with lifecycle)
   - Access (role bindings)
   - Settings (rename, labels, Grafana URL template, rotate cert, disable, delete)
4. **Backup detail:** spec, status, timeline, warnings/errors, resource list, volumes (PVB/DataUpload progress), logs, YAML view, "Restore from this backup" action.
5. **Restore wizard:** choose backup (or schedule latest) → scope (namespaces/resources/labels) → namespace mapping → options (existing resource policy, PV restore, etc.) → review with CLI equivalent + **impact summary** (target namespaces, whether any exist and would be touched) → sudo re-auth → submit / request approval.
6. **Backup create wizard** and **Schedule wizard** (cron builder with human-readable preview and next 5 run times in the user's timezone).
7. **Restore detail:** like backup detail.
8. **Log viewer** (shared component): follow, pause, wrap, search, timestamps, download visible buffer.
9. **Org admin:** members, invites, teams, SSO config, security settings, API tokens.
10. **Audit log:** filter by actor/action/cluster/date; CSV export.
11. **Alerts:** rules, channels, history.
12. **Reports:** success rate over time per cluster, namespaces without backup in X hours, RPO compliance per schedule.
13. **Add cluster** flow: name → helm command (copy) → live "waiting for agent…" → connected.

### 11.2 UX requirements

- Every destructive action uses a typed confirmation (type the resource name) plus sudo re-auth.
- Every action that queues a command shows a toast linking to the command's live status.
- Actions disabled by RBAC, agent policy, Velero version, or a disconnected cluster stay **visible but disabled with a tooltip giving the reason**.
- Time shown in the user's timezone with UTC on hover.
- Dark/light theme, responsive down to tablet, keyboard accessible, WCAG 2.1 AA contrast.
- Empty states explain what to do next.

---

## 12. Security requirements (apply from day 1)

### 12.1 Platform
- TLS everywhere. The gRPC gateway requires mTLS for `Connect`/`Renew`.
- Internal CA private key stored encrypted with `VFM_MASTER_KEY`. CA rotation supported: new CA cert distributed in `HelloAck`, agents trust both during overlap.
- All secrets come from env/Kubernetes Secrets; never in config files committed to git.
- Security headers: strict CSP (no inline scripts, no third-party origins), HSTS, X-Frame-Options DENY, Referrer-Policy.
- Input validation at every boundary: REST (zod), gRPC (agent output validated before DB write — **treat the agent as semi-trusted**: a compromised cluster must not be able to corrupt another cluster's data or inject script into the UI). Escape everything rendered in the UI. Cap JSON sizes.
- Redaction: a central `redact()` used before logging, before writing `commands.payload`, and before writing audit details. Unit tests cover credential fields.
- Dependency scanning (`pnpm audit`, `govulncheck`) and image scanning (Trivy) in CI. Fail on high/critical.
- Containers: non-root, read-only root FS, drop all capabilities, seccomp RuntimeDefault.

### 12.2 Agent RBAC (ClusterRole + Role in the Velero namespace). Nothing more than this.
- Cluster-wide read: `get/list/watch` on `nodes`, `namespaces`, `pods`, `persistentvolumeclaims`, `events`; `get` on `pods/log`.
- `velero.io` group (in the Velero namespace only): `get/list/watch/create/update/patch/delete` on backups, restores, schedules, backupstoragelocations, volumesnapshotlocations, deletebackuprequests, downloadrequests, serverstatusrequests; `get/list/watch` on backuprepositories, podvolumebackups, podvolumerestores, datauploads, datadownloads.
- Secrets: `create/update/get` **only in the Velero namespace**, restricted with `resourceNames` where possible. Secrets in `vfm-system` for the agent's own cert/key. Lease in `vfm-system` for leader election. ConfigMap in `vfm-system` for the idempotency cache.
- **No** cluster-wide secrets read. **No** exec. **No** wildcard verbs or resources.

### 12.3 Threat model document
In M7, write `docs/THREAT_MODEL.md` (STRIDE per component) and verify every mitigation listed there with a test or a documented manual check.

---

## 13. Non-functional requirements

| Area | Target |
|---|---|
| Scale (v1) | 200 connected clusters, 100 concurrent UI users, 50k Velero objects total, 20k pods per cluster |
| Latency | UI list endpoints p95 < 300 ms at target scale; command reaches agent < 1 s p95 when connected; resource event reaches browser < 3 s p95 |
| Agent footprint | < 100 MiB memory and < 100m CPU steady state on a 5k-pod cluster |
| Availability | Control plane survives loss of one replica with no lost commands; agents reconnect within 60 s |
| Data durability | Postgres is the only durable store; documented backup procedure for VFM's own DB (eat your own dog food: a Velero schedule example for the VFM namespace) |
| Upgrades | Zero-downtime control plane rolling upgrade; DB migrations are backward compatible for one release (expand → migrate → contract) |
| Observability | Prometheus metrics: connected agents, command counts/latency by type & status, stream reconnects, SSE subscribers, HTTP latency, job queue depth. Ship a Grafana dashboard JSON. |
| Air-gap | `docs/AIRGAP.md`: image list, chart packaging, private registry overrides, no outbound calls verified by an e2e run with egress blocked |

Load test (M7): a Go "fake agent" simulator that opens N streams and generates realistic inventory and events, used to prove the scale targets.

---

## 14. Repository layout and dev environment

```
/
├── PLAN.md                     # this file
├── docs/ PROGRESS.md DECISIONS.md THREAT_MODEL.md AIRGAP.md OPERATIONS.md API.md
├── proto/vfm/agent/v1/*.proto  # buf.yaml, buf.gen.yaml
├── agent/                      # Go module
│   ├── cmd/agent/main.go
│   ├── internal/{conn,enroll,commands,velero,inventory,logs,policy,idempotency,config}
│   └── test/                   # envtest + integration
├── server/                     # NestJS
│   ├── src/{auth,orgs,clusters,rbac,commands,gateway,inventory,velero,logs,stream,audit,alerts,reports,crypto,ca,common}
│   ├── prisma/
│   └── test/
├── web/                        # React app
├── packages/shared/            # zod schemas, permission constants, generated API types
├── tools/fake-agent/           # Go load simulator
├── deploy/
│   ├── helm/vfm-control-plane/
│   ├── helm/vfm-agent/
│   └── dev/                    # docker-compose, kind configs, minio, velero install scripts
├── e2e/                        # Playwright + Go e2e
└── .github/workflows/
```

### 14.1 Local dev (`make dev-up`)
- docker compose: Postgres, Redis, MinIO (two buckets), Mailpit (SMTP catcher), a mock OIDC provider (e.g. Dex with static users).
- Two kind clusters (`vfm-a`, `vfm-b`), each with Velero `VELERO_PRIMARY` + the AWS plugin pointed at MinIO, the CSI snapshot controller + hostpath CSI driver (to test volume snapshots), node-agent enabled (to test file-system backup), and sample workloads (nginx + a StatefulSet with a PVC holding known data).
- Control plane and web run locally with hot reload. Agents run in the kind clusters (image loaded via `kind load`) or locally against kubeconfig with `--dev`.
- Seed script: platform admin, two orgs, users for each built-in role, both clusters enrolled.

---

## 15. Testing strategy

| Layer | Tool | Must cover |
|---|---|---|
| Agent unit | `go test` | command → CR mapping for every op, policy enforcement, idempotency, redaction, capability gating |
| Agent integration | envtest (real API server, Velero CRDs installed) | informers → events, CR creation, DownloadRequest flow with a fake HTTP object store |
| Server unit | Vitest/Jest | RBAC & namespace-scope rule (table-driven, 50+ cases), org isolation, command state machine, crypto, redaction, alert rules |
| Server integration | Testcontainers (Postgres, Redis) + an in-process fake agent over real gRPC | enrollment, mTLS, reconnect, re-delivery, revocation, SSE fan-out across 2 server instances |
| Web unit | Vitest + Testing Library | forms → payload mapping, CLI-equivalent generator, permission-disabled states |
| E2E | Playwright against kind + MinIO + Velero | see the golden path list below |
| Security | custom tests | cross-org access attempts on every endpoint (auto-generated from OpenAPI), scoped user cannot back up/restore outside scope, CSRF, rate limit, agent cannot report data for another cluster |
| Load | fake-agent | Section 13 targets |

**E2E golden paths (must all pass before release):**
1. Enroll cluster → connected within 30 s.
2. Create backup of namespace `demo` with FS backup → Completed → logs viewable → details show the PVC.
3. Delete namespace `demo` → restore → pod running and PVC data checksum matches.
4. Restore with namespace mapping `demo → demo-restored`.
5. Schedule every 5 minutes → backup appears → pause → no new backup → unpause.
6. Create a BSL with credentials → Available. Credentials are never visible in the API, DB, or logs (grep test).
7. Scoped Operator (namespace `demo` only) is denied a backup of `kube-system` and of all namespaces.
8. Agent killed mid-command → restarts → command completes exactly once.
9. Control-plane replica killed → agent reconnects to the other → commands continue.
10. Agent policy `readOnly: true` → mutating actions disabled in the UI and rejected by the agent.
11. Cluster disabled → stream closed → reconnect refused.
12. Alert: failed backup (pointed at a broken BSL) → webhook received → resolves when fixed.

---

## 16. Milestones and day-by-day plan

> One "day" = one focused working session for Claude Code. End every day with `make test` green and `PROGRESS.md` updated. Estimates assume no major blockers. If a day overruns, split it and log that rather than cutting corners.

### M0 — Foundation (Days 1–3)

**Day 1 — Repo skeleton**
- Monorepo layout (Section 14), pnpm workspaces, Go module, Taskfile/Makefile, editorconfig, lint configs (eslint, prettier, golangci-lint), commit hooks.
- `docs/PROGRESS.md`, `docs/DECISIONS.md` (ADR-001: stack choices from Section 4; ADR-002: pinned Velero version + module path, after verifying).
- CI workflow: lint + unit test jobs (empty tests pass).

**Day 2 — Dev environment**
- docker compose (Postgres, Redis, MinIO, Mailpit, Dex).
- kind cluster scripts (`vfm-a`, `vfm-b`) with Velero + MinIO + CSI hostpath + node-agent + sample workloads.
- `make dev-up` / `make dev-down` are idempotent. A smoke script runs `velero backup create` via the CLI on each cluster and asserts Completed.

**Day 3 — Service skeletons**
- NestJS app with config module (zod-validated env), pino logging, request IDs, health/readiness, Prisma connected, first migration (users, orgs, memberships).
- React app shell: routing, layout, theme, API client generated from OpenAPI, error boundary.
- Agent `main.go`: config, slog, health server, kube client, leader election.

**Exit criteria:** `make dev-up` brings up everything from a clean machine; CI is green; the Velero smoke backup passes on both kind clusters.

---

### M1 — Identity, orgs, RBAC core (Days 4–9)

**Day 4 — Users & local auth**
- Registration of the first platform admin via a one-time setup token printed in the logs on first start. No open self-signup.
- Login/logout, argon2id, Redis sessions, CSRF, rate limiting, lockout.

**Day 5 — MFA & sudo mode**
- TOTP enroll/verify/disable, recovery codes (10, hashed), org-enforced MFA, sudo re-auth endpoint + guard decorator.

**Day 6 — Orgs, members, invites, teams**
- CRUD, email invites via SMTP (Mailpit in dev), org switcher, the org-scoping Prisma extension + the "every query is org-scoped" test.

**Day 7 — OIDC**
- Per-org providers, login flow, JIT provisioning, group → team mapping. Tested against Dex.

**Day 8 — RBAC engine**
- Permission constants in `packages/shared`, built-in roles as data, role bindings (user/team, cluster/namespace/selector scope).
- `authorize(user, clusterId, permission, {namespaces?, includesClusterScoped?})` + Nest guard.
- Table-driven tests (50+ cases), including team inheritance, org-admin implicit rights, and scope edge cases (wildcard, empty, mapping).

**Day 9 — Audit log + API tokens + UI**
- `audit_events` append-only (DB role grants), audit interceptor on all mutating routes, audit UI + CSV export.
- API tokens: create (shown once), list, revoke, permission subset.
- UI: login, MFA, org admin pages, members/teams/SSO/tokens.

**Exit criteria:** E2E: admin setup → invite user → user logs in with MFA → OIDC login works → cross-org access tests pass for all existing endpoints. ⛔ **HUMAN CHECKPOINT** — the human reviews the RBAC model and the auth flows before the agent work starts.

---

### M2 — Agent protocol, enrollment, connectivity (Days 10–15)

**Day 10 — Proto contract**
- Write `proto/` fully for M2–M5 messages (Section 5.2), with Velero fields derived from the pinned types. `buf lint`, `buf breaking` in CI, codegen for Go and TS.

**Day 11 — Internal CA & enrollment**
- CA bootstrap (generated on first start, encrypted with `VFM_MASTER_KEY`), CSR signing, cert table, deny-list.
- Bootstrap tokens: issue/hash/expire/burn. `Enroll` and `RenewCertificate` RPCs.
- Add-cluster UI flow + generated Helm command.

**Day 12 — Agent connection manager**
- Enroll on first start, persist key/cert in a Secret, mTLS `Connect`, `Hello`, heartbeats, reconnect with backoff + jitter, cert renewal, graceful shutdown, leader election gating.

**Day 13 — Gateway & routing**
- Server: stream registry, Redis routing (`agent:{clusterId} → replica`), connection status updates, `last_seen_at`, disconnect detection (45 s), revocation closes streams.
- Run 2 server replicas locally; verify routing.

**Day 14 — Command pipeline (generic)**
- `commands` table + state machine, queue → route → send → ack/result, deadlines/timeouts, re-delivery on reconnect, cancel.
- Agent: dispatcher, allowlist, policy (Section 5.5), idempotency LRU + ConfigMap persistence, labels on created objects.
- Implement only `RefreshServerStatus` end to end as the first real command.

**Day 15 — Helm chart for the agent + hardening of the stream**
- Agent chart: RBAC exactly per 12.2, policy ConfigMap, PDB, securityContext, resources, image override, proxy env vars, custom CA.
- Tests: agent killed mid-command, server replica killed, revoked cert, wrong-cluster fingerprint, token reuse.

**Exit criteria:** both kind clusters enroll from the UI-generated Helm command, show Connected, display Velero version and plugins; e2e golden paths 1, 8 (with `RefreshServerStatus`), 9, and 11 pass. ⛔ **HUMAN CHECKPOINT** — the human installs the agent on one real (non-kind) cluster and confirms it connects.

---

### M3 — Read-only Velero visibility (Days 16–20)

**Day 16 — Inventory sync (agent)**
- Informers for all Velero kinds in 5.3 (respecting detected-version capabilities), snapshot chunking, delta batching, periodic resync.

**Day 17 — Inventory ingest (server)**
- Atomic snapshot replace, delta upsert, `velero_resources` with extracted columns, validation of agent payloads (semi-trusted), SSE `/stream` with per-user permission filtering.

**Day 18 — Fleet overview + cluster overview UI**
- Fleet table/cards, needs-attention list, cluster overview tab, live updates via SSE.

**Day 19 — Lists & detail pages**
- Backups, restores, schedules, storage (BSL/VSL/repos) lists with filters/sorting/pagination; backup and restore detail pages (spec/status/timeline/YAML).

**Day 20 — DownloadRequest pipeline**
- `FetchDownload` command: agent creates the DownloadRequest, waits, fetches from the signed URL in-cluster, gunzips, and streams chunks; server caches per 7.3; UI log viewer for backup/restore logs; "describe --details" panels (resource list, volume info, item operations, results).

**Exit criteria:** every Velero object created via the CLI in kind appears in the UI within 3 s; backup/restore logs and details render; a scoped Viewer sees only permitted data. ⛔ **HUMAN CHECKPOINT** — UI review.

---

### M4 — Velero write operations (Days 21–27)

**Day 21 — Backups**
- `CreateBackup` (all flags in Section 6), `DeleteBackup`, `TriggerScheduleNow`. Namespace-scope authorization. `advanced_spec_json` with agent-side strict validation.

**Day 22 — Backup wizard UI + CLI-equivalent generator**
- Multi-step form, validation, live CLI preview, command-status toast, typed delete confirmation + sudo.

**Day 23 — Restores (backend + agent)**
- `CreateRestore` (all flags), namespace mapping, scope check on **target** namespaces, agent policy denied namespaces, `DeleteRestore`.

**Day 24 — Restore wizard UI**
- Including the impact summary (which target namespaces exist now) and sudo re-auth.

**Day 25 — Schedules**
- Create/update/pause/unpause/delete/run-now; cron builder with next-5-runs preview.

**Day 26 — Storage locations**
- BSL/VSL upsert/delete/set-default, credential handling (transient, redacted, agent writes the Secret), availability status display.

**Day 27 — Write-ops test sweep**
- E2E golden paths 2, 3, 4, 5, 6, 7, 10. Grep test: credentials never appear in DB dumps, server logs, agent logs, or audit.

**Exit criteria:** golden paths 1–11 pass on `VELERO_PRIMARY` **and** the oldest supported minor. ⛔ **HUMAN CHECKPOINT** — the human performs a real backup + restore drill on a non-kind cluster.

---

### M5 — Cluster live view and live logs (Days 28–31)

**Day 28 — Core inventory (agent + server)**
- Nodes, namespaces, pod summaries (strict field allowlist, no env/specs), PVCs, events; large-cluster `WatchScope` mode.

**Day 29 — Workloads UI**
- Nodes table, namespaces with "last successful backup covering this namespace" and coverage badges, pods → containers drill-down, events tab.

**Day 30 — Live log sessions**
- Start/stop sessions, agent `pods/log` follow streaming, limits/timeouts (5.6), SSE fan-out, audit of session starts, Velero server/node-agent shortcuts, previous-container logs.

**Day 31 — Log viewer polish + tests**
- Follow/pause/search/wrap/download; tests for limits, permission denial, the agent policy `logStreamDeniedNamespaces`, and session cleanup when the browser disconnects.

**Exit criteria:** live logs stream with < 2 s latency from kind; 10 concurrent sessions are stable; a denied namespace is blocked both server-side and agent-side.

---

### M6 — Alerts, reports, approvals (Days 32–35)

**Day 32 — Alert engine**
- Rule types: backup Failed/PartiallyFailed, schedule missed (no backup within cron interval × 1.5), agent disconnected > N min, BSL Unavailable, backup storage nearing expiry with no newer backup. Dedup by fingerprint, resolve notifications, re-notify interval.

**Day 33 — Channels + alert UI**
- Email, generic webhook (HMAC-signed body), Slack-compatible webhook; test-send button; rules/channels/history pages. Golden path 12.

**Day 34 — Reports**
- Success rate over time, namespace coverage (namespaces with no successful backup in X hours), RPO compliance per schedule; charts + CSV export; computed via SQL over `velero_resources`.

**Day 35 — Restore approval workflow**
- Org/cluster setting, `PENDING_APPROVAL`, approve/reject by a different authorized user, notifications, audit.

**Exit criteria:** golden path 12 passes; reports match hand-computed values on seeded data.

---

### M7 — Hardening, scale, security review (Days 36–40)

**Day 36 — Threat model**
- Write `docs/THREAT_MODEL.md` (STRIDE per component). Add a test or a documented manual check for each mitigation. Fix gaps found.

**Day 37 — Security test suite**
- Auto-generated cross-org/permission tests for every OpenAPI operation; CSP/headers check; agent payload fuzzing (malformed/oversized/wrong-cluster data); `govulncheck`, `pnpm audit`, Trivy in CI with fail thresholds.

**Day 38 — Fake-agent load test**
- Simulate 200 clusters × realistic objects; measure the Section 13 targets; fix the hot spots (indexes, batching, SSE fan-out).

**Day 39 — Resilience**
- Chaos-style tests: Postgres restart, Redis restart, network partition between agent and server, slow agent; verify no lost or duplicated commands; key rotation (`VFM_MASTER_KEY`, CA).

**Day 40 — Platform observability**
- Metrics listed in Section 13, Grafana dashboard JSON, structured log fields documented, OpenTelemetry tracing hook (off by default).

**Exit criteria:** load targets met (report committed to `docs/LOADTEST.md`); zero high/critical vulnerabilities; threat model mitigations all verified. ⛔ **HUMAN CHECKPOINT** — the human reviews the threat model and load-test results.

---

### M8 — Packaging, docs, release (Days 41–44)

**Day 41 — Control-plane Helm chart**
- Deployments, HPA, PDB, Ingress/Gateway examples for both HTTPS and gRPC passthrough, external Postgres/Redis values, secrets via existing-secret references, migrations as a pre-upgrade Job, NetworkPolicies.

**Day 42 — Air-gap & upgrades**
- `docs/AIRGAP.md`, image list script, `helm package` bundle, private-registry overrides; e2e run with egress blocked; upgrade test from the previous tag (migrations expand/contract).

**Day 43 — Documentation**
- `README.md` (quickstart), `docs/OPERATIONS.md` (install, upgrade, backup of VFM itself, key rotation, troubleshooting agent connectivity/proxies/L7 balancers), `docs/API.md` (from OpenAPI), user guide for each page, RBAC reference.

**Day 44 — Release candidate**
- Version tagging, changelog, signed images (cosign) optional, full e2e matrix on both Velero versions, production-readiness checklist (Section 17) filled in.

**Exit criteria:** Section 17 fully checked. ⛔ **HUMAN CHECKPOINT** — release decision.

---

## 17. Production-readiness checklist (Definition of Done for v1)

- [ ] All 12 e2e golden paths pass on `VELERO_PRIMARY` and the oldest supported minor
- [ ] No stubbed/mocked production code paths; `Deferred` list in PROGRESS.md reviewed
- [ ] Org isolation tests cover 100% of OpenAPI operations
- [ ] Namespace-scope authorization has ≥ 50 table-driven test cases, all passing
- [ ] Credentials grep test passes (DB dump, all logs, audit, command payloads)
- [ ] Agent RBAC exactly matches Section 12.2 (checked by a test that renders the chart and diffs the rules)
- [ ] Threat model written; each mitigation verified
- [ ] Load test meets Section 13 targets
- [ ] Zero high/critical vulnerabilities in deps and images
- [ ] Air-gapped install verified with egress blocked
- [ ] Upgrade from previous version verified without downtime
- [ ] Docs: README, OPERATIONS, AIRGAP, API, RBAC reference, user guide
- [ ] Grafana dashboard + alerts for VFM itself
- [ ] Restore drill on a real non-kind cluster performed and documented by the human

---

## 18. Open questions (defaults apply unless the human answers)

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | Self-hosted product only, or also run as a SaaS by you? | Self-hosted only. Multi-org exists for MSPs/large enterprises, not SaaS billing. |
| Q2 | Expected max clusters per installation in year 1? | 200 (Section 13) |
| Q3 | Must the agent work through an HTTP proxy that does not support HTTP/2 or long-lived streams? | Assume HTTP/2 works. Respect `HTTPS_PROXY`. If not, ADR for a WebSocket transport fallback in v1.1. |
| Q4 | Which Velero version is the oldest that real target clusters run? | Primary minus 2 minors |
| Q5 | Is downloading backup contents through the browser ever acceptable? | Off by default; presigned URL only; Cluster Admin only |
| Q6 | License and product name | Keep internal; decide before the public release |
| Q7 | Any compliance target (SOC 2, ISO 27001) that affects audit retention? | 400-day audit retention, CSV export |
