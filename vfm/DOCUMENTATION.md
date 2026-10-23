# Velero Fleet Manager

One document for the whole product: what it is, how to install it, how it is built, how to use and run it, and why it is built that way.

**Contents**

1. [What it is](#1-what-it-is)
2. [Install it, step by step](#2-install-it-step-by-step)
3. [How it works](#3-how-it-works)
4. [Using the product](#4-using-the-product)
5. [Repository and development](#5-repository-and-development)
6. [Operations](#6-operations)
7. [Security](#7-security)
8. [Decisions](#8-decisions)
9. [Open items and known gaps](#9-open-items-and-known-gaps)
10. [Legacy Velero UI](#10-legacy-velero-ui)
11. [Appendix: where the plan's sections went](#11-appendix-where-the-plans-sections-went)

---

## 1. What it is

Velero Fleet Manager (VFM) manages [Velero](https://velero.io) backups across many Kubernetes clusters from one web UI.

A small Go **agent** runs in each cluster and dials **out** to the central **control plane** over a mutually authenticated gRPC stream. The control plane sends typed commands (create a backup, restore, change a schedule); the agent carries them out by creating or patching Velero custom resources, then streams back status, logs and cluster health. **Backup data never passes through VFM**: Velero writes straight to its own object storage.

### Principles (binding)

| #   | Principle                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------- |
| P1  | The agent dials out only. The control plane never connects into a cluster and holds no kubeconfig.      |
| P2  | Backup data never transits VFM, only metadata, status, logs and commands.                               |
| P3  | The agent is a typed command executor: no generic kubectl, no exec, no arbitrary YAML apply.            |
| P4  | Least privilege: a fixed, minimal agent RBAC; users get only what a role grants on a cluster/namespace. |
| P5  | Every state-changing action is audited: who, what, where, when, outcome.                                |
| P6  | Air-gap capable: no CDN assets, no runtime calls to the internet, all images and charts mirrorable.     |

### Scope

**In:** multi-cluster enrolment and health; all day-2 Velero operations (backups, restores, schedules, storage locations, volume snapshot locations, repositories, logs, details, delete, signed-link download); live cluster view and live log tail; organizations, teams, roles with per-cluster and per-namespace scope; local login with TOTP MFA, OIDC and LDAP; API tokens; audit; alerts (email, webhook, Slack-compatible webhook); reports (CSV, PDF); Helm charts; Prometheus metrics and JSON logs.

**Out:** installing, upgrading or removing Velero itself (VFM only detects and reports its version and plugins); storing container logs centrally or acting as an observability platform; `velero debug` bundles; cross-cluster restore; billing and SaaS multi-region; ClamAV scanning.

### Requirement map (SOW FR-01 to FR-20)

| FR    | Requirement               | Status    | Where it lives                                                                                                                                                  |
| ----- | ------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-01 | Standalone installation   | Built     | Docker quickstart (§2) and Helm chart; install, upgrade, backup and rollback in §6                                                                              |
| FR-02 | Multi-cluster inventory   | Built     | Cluster name, environment type, API endpoint (informational, never dialled), owner, labels, versions, status. No list column or filter for the new metadata yet |
| FR-03 | Cluster connectivity      | Different | Agent with outbound mTLS instead of a kubeconfig; enrolment validates identity, agent RBAC is fixed by the chart (ADR-052)                                      |
| FR-04 | Per-cluster Velero status | Built     | Version, plugins, storage and snapshot locations, node-agent and data-mover objects, warnings (cluster overview)                                                |
| FR-05 | Dashboard                 | Built     | Fleet overview with four charts, per-cluster overview (§4)                                                                                                      |
| FR-06 | On-demand backup          | Built     | Backup wizard with live `velero` CLI preview                                                                                                                    |
| FR-07 | Scheduled backup          | Built     | Create, edit, pause, resume, run now, delete; cron builder                                                                                                      |
| FR-08 | Backup lifecycle          | Built     | List, filter, inspect, delete (typed confirmation and sudo); download is a short-lived signed link, off by default                                              |
| FR-09 | Restore workflow          | Partial   | Same cluster, namespace mapping, resource filters, review before running. Restoring into a different registered cluster is not built                            |
| FR-10 | Restore safeguards        | Partial   | Existing-namespace check, risk list and explicit acknowledgement. Missing CRDs and storage classes on the target are not checked                                |
| FR-11 | Logs and diagnostics      | Built     | Phase, timestamps, warnings and errors, Velero logs, events, live pod logs; secrets never exposed                                                               |
| FR-12 | Storage configuration     | Built     | Backup and snapshot locations per cluster; credentials write-only                                                                                               |
| FR-13 | Notifications             | Built     | Email, signed webhook and Slack webhook; failed backup, missed schedule, agent disconnected, storage unavailable, backup expiring                               |
| FR-14 | Audit trail               | Built     | Append-only, CSV export                                                                                                                                         |
| FR-15 | Reports and export        | Built     | Success rate, coverage, RPO as CSV or PDF                                                                                                                       |
| FR-16 | Search and filter         | Built     | Filters on every list, plus fleet-wide backups, restores and schedules                                                                                          |
| FR-17 | Health monitoring         | Built     | Agent loss, failed schedules, storage unavailable, stale inventory feed the "needs attention" list and alerts                                                   |
| FR-18 | ClamAV readiness          | Not built | Optional (Could)                                                                                                                                                |
| FR-19 | Configuration backup      | Built     | Secret-free JSON export; there is no import (§6.5)                                                                                                              |
| FR-20 | Version compatibility     | Built     | Velero compatibility matrix; unsupported versions warn or block commands                                                                                        |

---

## 2. Install it, step by step

This is the quickest way to run everything on one machine: the control plane, its database and cache, in Docker. It uses throwaway passwords and is **for trying the product**. For production use the Helm chart (§6.1).

You do not need Kubernetes, Go or Node for this guide. You do need a Kubernetes cluster with Velero only when you want to connect a real cluster (step 9).

### Step 0. Prerequisites

| You need                 | Check with                          | Expected                       |
| ------------------------ | ----------------------------------- | ------------------------------ |
| Docker Engine            | `docker --version`                  | a version number               |
| Docker Compose v2        | `docker compose version`            | `Docker Compose version v2...` |
| Git                      | `git --version`                     | a version number               |
| Ports 3000 and 8443 free | `ss -ltn \| grep -E ':3000\|:8443'` | no output                      |
| A web browser            |                                     |                                |

Get the code and open the folder that holds the root `docker-compose.yml`:

```bash
git clone <repository-url>
cd velero-ui
git checkout vfm/m0-foundation     # the branch that contains the vfm/ folder
```

### Step 1. Start everything

```bash
docker compose up -d --build
```

The first run builds the control-plane image, which takes a few minutes. It starts four things: PostgreSQL, Valkey (a Redis-compatible cache), a one-off database migration, and the control plane.

> If the build or start fails with `Bind for 127.0.0.1:3000 failed: port is already allocated`, something else uses the port. Stop it, or see the troubleshooting table below.

### Step 2. Check that it is healthy

```bash
docker compose ps                         # migrate exits (0); the others are Up
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/readyz    # 200
```

### Step 3. Get the one-time setup token

On first start the control plane prints a token to its log. It works once and is valid for 24 hours.

```bash
docker compose logs control-plane | grep -ao 'token\\":\\"[A-Za-z0-9_-]*' | sed 's/.*\\"//'
```

Copy the line that is printed. If it prints nothing, a user already exists and the token is gone (see troubleshooting).

### Step 4. Create the administrator

Open <http://localhost:3000/setup>.

![First-time setup](docs/images/01-setup.jpg)

Paste the token, enter an email address and a password of **at least 12 characters** (the password must not be in the bundled breached-password list), and press **Create administrator**. You are signed in and land on an empty overview:

![First sign-in, no organization yet](docs/images/02-first-login.jpg)

### Step 5. Sign in, and set up two-step verification

Platform administrators and organization owners/admins always need a second factor. The next time you sign in at <http://localhost:3000/login>:

![Sign in](docs/images/03-sign-in.jpg)

you are asked to set up an authenticator:

![Two-step verification prompt](docs/images/04-mfa-prompt.jpg)

Press **Start setup**. Add the displayed key to an authenticator app (Google Authenticator, Aegis, 1Password and similar); the page also shows an `otpauth://` link for apps that accept one. Type the six-digit code and press **Confirm**:

![Authenticator key and code](docs/images/05-mfa-key.jpg)

The product also issues single-use recovery codes, stored only as hashes. Keep them somewhere safe.

> **Local-only shortcut.** If you cannot use an authenticator while you are just looking around, `DEV_DISABLE_MFA=true` on the control plane skips the requirement. The server refuses to start with it when `NODE_ENV=production`. Never leave it on in a real installation (§9).

### Step 6. Create an organization

An organization holds members, teams, clusters, alert rules and an audit trail. Nothing crosses organizations. Open **New organization** in the sidebar (or <http://localhost:3000/admin/orgs/new>), enter a name and a slug (lowercase letters, digits, hyphens; used on the sign-in page) and press **Create organization**.

![Create an organization](docs/images/06-new-organization.jpg)

Select the organization in the header drop-down. With no clusters yet the overview invites you to add one:

![Empty fleet overview](docs/images/07-empty-overview.jpg)

### Step 7. Add a cluster

Go to **Clusters**, type a name (letters, digits, space, dot, underscore, dash) and press **Add cluster**. This creates the cluster record and a one-time bootstrap token. Nothing is installed yet.

![Add a cluster](docs/images/08-add-cluster.jpg)

The page then prints the exact install command. The token is single-use, expires in 24 hours and **is shown only once**: copy it now (or use **New token** later).

![Install command with CA bundle and token](docs/images/09-install-command.jpg)

### Step 8. Make the gateway address reachable from your cluster

The command contains `controlPlane.address=localhost:8443`. That is right only for a cluster that runs on the same machine as the control plane. For any other cluster, give the control plane an address the cluster can reach, **before** you press Add cluster:

```yaml
# docker-compose.override.yml  (next to docker-compose.yml)
services:
  control-plane:
    environment:
      GATEWAY_PUBLIC_ADDRESS: vfm.example.internal:8443 # what agents dial
      GATEWAY_HOSTNAMES: vfm.example.internal,localhost # names in the gateway certificate
```

Restart with `docker compose up -d`. The agent gateway uses mutual TLS and must be **passed through**, never terminated by a proxy (§6.1).

### Step 9. Install the agent on the cluster

Run the printed command on a machine that has cluster-admin access to the target cluster and a working Velero installation. Until the agent chart and image are published to a registry, build them from this repository:

```bash
docker build -t ghcr.io/shubhambatra/vfm-agent:0.1.0 vfm/agent     # then push/load the image where the cluster can pull it
helm install vfm-agent vfm/deploy/helm/vfm-agent -n vfm-system --create-namespace \
  --set controlPlane.address=<host>:8443 \
  --set-file controlPlane.caBundle=vfm-ca.pem \
  --set enrollment.token=<token>
```

(`vfm-ca.pem` is created by the first part of the printed command.)

### Step 10. See the cluster connect

Within seconds the cluster turns **connected** and shows its Velero and Kubernetes versions. The overview fills with data:

![Fleet overview with charts](docs/images/10-fleet-overview.jpg)
![Cluster table and health tiles](docs/images/11-fleet-clusters.jpg)

The screenshots above come from five **simulated** clusters (see §5.4), so the charts have data without real clusters. The agent column shows `loadtest` for them.

### Step 11. Stop, start, reset

```bash
docker compose stop          # stop, keep the data
docker compose up -d         # start again
docker compose down          # remove the containers, keep the database volume
docker compose down -v       # also delete the database (you will see Setup again)
```

### Troubleshooting the install

| Symptom                                                        | Cause and fix                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `port is already allocated` on 3000 or 8443                    | Another stack (for example an earlier `vfm-quickstart` project) holds it. `docker ps` shows which; stop it, then `docker compose up -d`.                           |
| Control plane exits; log says `getaddrinfo EAI_AGAIN postgres` | Docker's DNS was not ready after a failed or interrupted start. `docker compose down` then `docker compose up -d` (this keeps the data).                           |
| Setup token command prints nothing                             | A user already exists, so no token is issued. To start over, `docker compose down -v` (deletes the database). A restart prints a fresh token while no user exists. |
| `setup` says the password is rejected                          | Use at least 12 characters and avoid common or breached passwords.                                                                                                 |
| After signing in you only see a "Two-step verification" page   | The administrator must enrol an authenticator (step 5).                                                                                                            |
| The cluster stays `pending` after the helm command             | Check the agent log (`kubectl -n vfm-system logs deploy/vfm-agent`) against the table in §6.9.                                                                     |

---

## 3. How it works

### 3.1 Components

```mermaid
flowchart LR
  B[Browser: React SPA] -- HTTPS + SSE --> CP
  subgraph CP[Control plane: NestJS, N replicas]
    API[REST API /api/v1 + SSE stream]
    AUTH[Auth, RBAC, audit]
    CMD[Command service]
    GW[Agent gateway: gRPC mTLS :8443]
    WRK[Alert and retention timers]
    CA[Internal CA]
  end
  CP --> PG[(PostgreSQL)]
  CP --> RD[(Redis / Valkey)]
  subgraph C1[Cluster A]
    AG[vfm-agent: Go, leader-elected]
    V[Velero + node agent]
  end
  AG -- outbound only --> GW
  AG --> V
  V --> OS[(Object storage)]
```

| Component      | What it is                                                                                 | Port                                    |
| -------------- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| Control plane  | One image: REST API, SSE stream, agent gateway, and the built web app. Stateless           | 3000 UI+API, 8443 gateway, 9090 metrics |
| Agent          | One Helm release per managed cluster; leader-elected Lease so one of two replicas works    | 8081 health, 9090 metrics (local)       |
| PostgreSQL     | The only durable store: state, inventory, audit                                            | 5432                                    |
| Redis / Valkey | Sessions, agent-to-replica routing, pub/sub between replicas, rate limits, one-shot locks  | 6379                                    |
| Web            | React 19, Vite, TanStack Router and Query, Tailwind, recharts. Served by the control plane | none of its own                         |

### 3.2 Enrolment and trust

1. An admin presses **Add cluster**. The control plane creates a `clusters` row (`PENDING`) and a one-time bootstrap token (32 random bytes, stored hashed, 24 hours, bound to that cluster).
2. On first start the agent generates an ECDSA P-256 key **inside the cluster**, builds a CSR and calls the unary `Enroll(token, CSR, clusterFingerprint)`. The fingerprint is the UID of the `kube-system` namespace; it detects the same agent being installed into a different cluster. The agent trusts only the CA bundle it was given.
3. The control plane burns the token and signs a client certificate from its **internal CA** (7-day validity, SAN `spiffe://vfm/cluster/{id}`). The cluster becomes `ENROLLED`.
4. The agent opens the `Connect` stream with mTLS and renews its certificate at two thirds of its lifetime through `RenewCertificate`.
5. **Revocation**: disabling, rotating or deleting a cluster adds the certificate to a deny-list; the open stream is closed (within a minute at the latest) and cannot reconnect. Every stream re-checks its certificate each minute.

The internal CA key is stored encrypted under `VFM_MASTER_KEY`. Several replicas share one CA through the database.

### 3.3 The agent protocol

The contract is `proto/vfm/agent/v1/`. One bidirectional stream, `Connect`, carries everything.

- **Agent to server**: `Hello` (agent, protocol and Kubernetes versions, Velero version and plugins, capabilities, policy), `Heartbeat` (15 s), `CommandAck`, `CommandResult`, `InventorySnapshot` (chunked), `ResourceEvents` (batched deltas), `LogChunk`, `LogSessionEnded`.
- **Server to agent**: `HelloAck` (accepted version, intervals, limits), `Command`, `CancelCommand`, `StartLogSession`, `StopLogSession`, `RequestResync`, `WatchScope`.
- **Command operations** (the whole allowlist): create/delete backup, create/delete restore, create/update/pause/delete/trigger schedule, upsert/delete/set-default backup storage location, upsert/delete volume snapshot location, `FetchDownload`, `GetBackupDownloadUrl`, `RefreshServerStatus`, `CheckNamespaces`. An unknown operation is refused with a typed error, not ignored.
- **Escape hatch**: `advanced_spec_json` on create backup/restore/schedule is merged onto the generated spec and validated against the Velero type on the agent (unknown fields rejected). It needs the `advanced:write` permission.
- **Versioning**: `protocol_version` in `Hello`; the server supports the current and the previous one. `buf breaking` runs in CI. The chart version and image tag are reported, so the UI can show "agent update available".

**Command lifecycle**

```
QUEUED -> SENT -> ACKED -> RUNNING -> SUCCEEDED | FAILED
   |        |        └──> (reconnect) re-SENT
   └──> CANCELLED (by the user, before ACK)         any non-terminal -> TIMED_OUT
   PENDING_APPROVAL -> (approve) QUEUED | REJECTED   (restore approval, §3.8)
```

- The row is written **before** anything is sent, so a crash loses nothing. A pure state machine never moves a command backwards.
- Delivery is **at-least-once**; the agent keeps the last 10 000 command ids and their results (persisted to a ConfigMap) and replays the cached result instead of running a command twice. Created objects carry the labels `vfm.io/command-id`, `vfm.io/requested-by` and the annotation `vfm.io/managed=true`, so creation is idempotent even after an agent restart.
- "Command succeeded" means the Velero object was **created**. "Backup succeeded" is the Velero phase. The UI always shows both and never conflates them.
- Error codes: `INVALID_ARGUMENT`, `NOT_FOUND`, `ALREADY_EXISTS`, `FORBIDDEN_BY_AGENT_POLICY`, `UNSUPPORTED_BY_VELERO_VERSION`, `KUBE_API_ERROR`, `TIMEOUT`, `INTERNAL`.

**Example: "Create backup"**

1. The browser calls `POST /api/v1/orgs/{org}/clusters/{id}/backups`.
2. The control plane checks authentication, then RBAC (`backup:create` on the cluster and on every namespace in scope), then the payload.
3. It writes a `commands` row (`QUEUED`) and an audit row, then publishes to the Redis channel for that agent. The replica holding the stream sends the `Command` (`SENT`).
4. The agent validates (allowlist, schema, local policy), creates the `Backup` object and answers `CommandAck` then `CommandResult`.
5. The agent's informer sees the Backup move `InProgress` to `Completed`/`PartiallyFailed`/`Failed` and sends `ResourceEvents`; the control plane updates its inventory and pushes the change to subscribed browsers over SSE.
6. The alert timer notices a failure on its next pass.

**Agent-side policy** (defence in depth). A ConfigMap set by the cluster owner at install time, which the control plane cannot change: `allowRestore`, `restoreDeniedNamespaces` (default `kube-system`, `vfm-system`, `velero`), `allowBslWrite`, `allowLogStreaming`, `logStreamDeniedNamespaces`, `readOnly` (rejects every mutating command), `allowClusterScopedRestore` (chart default true; an agent with no policy at all denies). It is reported in `Hello`, so the UI shows disabled actions together with the reason.

**Limits**: 4 MB gRPC message, 64 KB log chunks, 10 concurrent log sessions per agent (oldest ended), 30 min log hard timeout and 60 s idle timeout, up to 5 000 buffered events while disconnected (on overflow the agent forces a full resync on reconnect), a per-stream message budget of 100/s with a burst of 1 000, and 30 enrolments per minute per source address.

### 3.4 Inventory and live data

- On connect the agent sends a full `InventorySnapshot` in chunks of at most 1 MB. The control plane assembles it in memory per cluster and swaps the inventory in **one transaction** when the last chunk arrives, so readers see the old state or the new one, never half of either. A delta is accepted only while a completed snapshot exists; any doubt triggers `RequestResync`.
- After that, informer deltas are debounced (2 s, 500 items). A full snapshot is resent every 10 minutes (self-healing against missed deltas).
- **Synced Velero kinds**: Backup, Restore, Schedule, BackupStorageLocation, VolumeSnapshotLocation, BackupRepository, PodVolumeBackup, PodVolumeRestore, DataUpload, DataDownload, DeleteBackupRequest (as the detected Velero version supports them). Which kinds exist is discovered, not assumed, and rediscovered at each resync.
- **Core kinds** (a _projection_, never a redaction): Node, Namespace, Pod, PVC, Event. A pod keeps phase, ready and restart counts, node, owner and per-container state; **no environment variables, commands, volumes, annotations or labels**. Events are warnings plus Velero-related, last hour. If a cluster has more than 20 000 pods the agent sends pod summaries only for namespaces a user opened in the last 10 minutes (`WatchScope`).
- **Secrets are never synced.** A storage location syncs only the secret name and key reference.
- **Live updates**: `GET /api/v1/stream` (Server-Sent Events) pushes resource, command and cluster-status events, filtered server-side per user permission, coalesced per cluster for 250 ms. The header shows "Live" or "Updates paused".

### 3.5 Logs

- **Live pod logs** (not stored): the browser opens `POST .../log-sessions`; the control plane records and audits it and tells the agent to stream `pods/log` when the first stream opens. Chunks are fanned out over SSE and nothing is written to Postgres. Needs `logs:read` on the namespace.
- **Velero logs and per-backup files** (log, resource list, volume info, item operations, results): the agent creates a `DownloadRequest`, fetches the signed URL **from inside the cluster**, gunzips and streams it back (size limit 16 MiB, hard 64 MiB). The server may cache these for 7 days.
- **Backup download** is the only way data leaves a cluster toward a browser, and VFM never carries it: with the org setting on, `backup:download` over every namespace of the backup, and sudo, the agent returns a signed link (about nine minutes; refused above 30). It is handed to one request with `Cache-Control: no-store` and never stored or logged.
- The web **log viewer** keeps the last 50 000 lines, supports follow, pause, wrap, search and download, and reads only SGR colour codes, so a log line cannot put markup on the page.

### 3.6 Identity and access

```
Platform admin (a flag on the user; bootstraps organizations)
└── Organization
    ├── Members: one org role each (Owner | Admin | Member)
    ├── Teams (OIDC group claims can map to teams)
    ├── Clusters -> role bindings: (user or team) -> role -> scope
    │      scope = whole cluster | list of namespaces | label selector
    ├── Notification channels, alert rules
    └── API tokens
```

- **Sign-in**: local email and password (argon2id, 12+ characters, bundled 97 747-entry breached-password list, no external calls) with TOTP MFA; per-organization **OIDC** with just-in-time provisioning off by default; optional **LDAP** for existing users. Sessions are httpOnly, Secure, SameSite=Lax cookies kept in Redis (12 h absolute, 1 h idle, rotated on privilege change). Double-submit CSRF protects every state-changing call. Brute-force protection counts per account and per address, with progressive delay and a timed lockout.
- **Sudo mode**: restore, any delete, storage writes, cluster deletion and role-binding changes need a password or MFA re-check within the last 5 minutes. API tokens are refused for these.
- **API tokens**: `vfm_` plus 43 characters, shown once, stored hashed; they can only **narrow** their owner's permissions and clusters. Bearer auth is opt-in per route.
- **LDAP**: set `LDAP_URL` (`ldaps://`, or `ldap://` with STARTTLS), `LDAP_SEARCH_BASE`, and optionally `LDAP_BIND_DN`/`LDAP_BIND_PASSWORD` and `LDAP_USER_FILTER` (default `(mail={email})`). When the local password does not match, the server finds the entry by email and binds as it. It never creates accounts; empty passwords, plain `ldap://` without STARTTLS and non-unique matches are refused; unknown addresses cost the same work as known ones.
- **OIDC**: register `<API_PUBLIC_URL>/api/v1/auth/oidc/callback` with the identity provider; users are matched by `(provider, subject)`, then by verified email only if already a member of that org.

**Cluster roles** (display name in the UI, stored value in brackets):

| Permission                                                                     | Read-only Auditor (VIEWER) | Backup Operator (OPERATOR) | Restore Operator (RESTORER) | Platform Administrator (CLUSTER_ADMIN) |
| ------------------------------------------------------------------------------ | :------------------------: | :------------------------: | :-------------------------: | :------------------------------------: |
| `cluster:read`, `backup:read`, `restore:read`, `schedule:read`, `storage:read` |            yes             |            yes             |             yes             |                  yes                   |
| `backup:logs`, `restore:logs`, `logs:read`                                     |                            |            yes             |             yes             |                  yes                   |
| `backup:create`                                                                |                            |            yes             |             yes             |                  yes                   |
| `schedule:write`                                                               |                            |            yes             |                             |                  yes                   |
| `restore:create`                                                               |                            |                            |             yes             |                  yes                   |
| `backup:delete`, `restore:delete`, `schedule:delete`                           |                            |                            |                             |                  yes                   |
| `storage:write`, `advanced:write`, `cluster:manage`                            |                            |                            |                             |                  yes                   |
| `backup:download` (also needs the org setting)                                 |                            |                            |                             |                  yes                   |

The full generated matrix, with each permission's scope, is [`docs/RBAC.md`](docs/RBAC.md); the REST reference is [`docs/API.md`](docs/API.md) (both generated, and a test fails if they drift).

**How a decision is made**

- **Deny by default, and on doubt.** A permission exists only where a binding grants it. The decision function is pure and lives in `packages/shared/src/rbac.ts`, so the server and the browser use the same code.
- A namespaced permission is checked against **every** namespace a request touches; all must be in scope. For a restore that means both the source and the mapped target namespace. A request that includes cluster-scoped resources, or a wildcard, needs a whole-cluster binding. Creating is stricter than reading: a scoped user must name every namespace and send `includeClusterResources: false`.
- A namespace-scoped binding still carries `cluster:read` and `storage:read`.
- Organization Owners and Admins are implicitly Cluster Admin on every cluster of their organization. The platform admin administers organizations, not their clusters.
- A cluster you may not see answers `404`; one you may see but not act on answers `403`. Hidden and missing objects are indistinguishable.
- **Org isolation** is enforced in a Prisma client extension: org-owned data can only be reached inside `prisma.inOrg(orgId, ...)` (or a reasoned `prisma.unscoped(...)`); otherwise the query throws. A new table with an `orgId` column is covered automatically.
- The cluster owner can narrow further with the agent policy; the control plane cannot widen it.

### 3.7 Audit

Every state-changing request, including refusals, is recorded: actor (user, token, system or agent), action, target, cluster, address, user agent, request id, outcome (`SUCCESS`, `DENIED`, `FAILED`) and redacted details. The table is **append-only**: a trigger refuses UPDATE, DELETE and TRUNCATE for everyone except direct members of the NOLOGIN role `vfm_audit_retention`. There are no foreign keys, so history outlives users and organizations. The write is best-effort after the response (accepted risk A-4). Viewing live logs is itself audited.

### 3.8 Restore approval, alerts, reports

- **Restore approval** is optional. The org setting `requireRestoreApproval` applies to every cluster; a cluster can only add its own switch, never remove the org's. A held restore is a `commands` row in `PENDING_APPROVAL`; another person who may restore the same namespaces approves or rejects it. Only the requester may withdraw it.
- **Alerts** evaluate _state_, not events: every 30 s (`ALERT_EVAL_INTERVAL_SECONDS`) one replica works out what is wrong now and reconciles it with open `alert_events` (a partial unique index keeps one open row per condition). New condition becomes `FIRING`, gone becomes `RESOLVED`, still there is re-notified after the rule's interval. Channels: email (SMTP), generic webhook (signed), Slack webhook. Destinations are validated: `https` only, no embedded credentials, private ranges refused unless allowed, link-local and metadata addresses always refused, the address connected to is the address checked, no redirects.
- **Reports** read narrow columns through the scoped client and aggregate in pure code. A report answer is shared for 30 s, keyed by what the caller may see, so a figure computed for someone who sees more is never served to someone who sees less.

### 3.9 Data model (PostgreSQL, Prisma)

All tables have `id` (UUIDv7), `created_at`, `updated_at`; org-owned tables have an indexed `org_id`. Migrations are committed and **expand-only** for one release.

| Group            | Tables                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity         | `users`, `organizations` (settings JSON), `memberships`, `teams`, `team_members`, `invites`, `oidc_providers`, `oidc_identities`, `mfa_recovery_codes`, `api_tokens`                                    |
| Clusters         | `clusters` (status, versions, plugins, policy, capabilities, labels, environment type, API endpoint, owner), `cluster_bootstrap_tokens`, `agent_certificates`, `certificate_authority`, `role_bindings` |
| Work             | `commands` (payload redacted; statuses incl. `PENDING_APPROVAL`, `REJECTED`)                                                                                                                            |
| Inventory        | `velero_resources` (current state, soft delete, indexed phase and timestamps; also holds core kinds), `velero_files` (cached logs and results)                                                          |
| Audit and alerts | `audit_events`, `alert_rules`, `notification_channels`, `alert_events`                                                                                                                                  |

Encrypted columns (`*_encrypted`) use AES-256-GCM envelope encryption with a key id stored per value; `VFM_MASTER_KEY` (32 bytes, base64) is the key-encryption key. Sessions live in Redis, not Postgres.

**Retention** (a daily job, one replica per interval): inventory events older than 1 h, finished commands older than 180 d, expired cached files, soft-deleted objects older than 7 d (backups 400 d), and audit events by each organization's own setting (default 400 days, minimum 30), optionally exported to CSV first.

### 3.10 Velero coverage

| Velero CLI                                                    | In VFM                                                                | Permission                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------ |
| `backup create` (all flags), `--from-schedule`                | Backup wizard; `TriggerScheduleNow`                                   | `backup:create`                |
| `backup get/describe [--details]`, `backup logs`              | Lists, detail page, `FetchDownload` files, log panel                  | `backup:read`, `backup:logs`   |
| `backup download`                                             | Signed link only, org setting and sudo                                | `backup:download`              |
| `backup delete`                                               | `DeleteBackup`                                                        | `backup:delete`                |
| `restore create/get/describe/logs/delete`                     | Restore wizard (namespace mapping, selectors, policies, modifiers)    | `restore:*`                    |
| `schedule create/get/describe/pause/unpause/delete`           | Schedule wizard and list                                              | `schedule:*`                   |
| `backup-location` / `snapshot-location` create/set/get/delete | Storage page; credentials sent once, written by the agent to a Secret | `storage:write`                |
| `repo get`, `plugin get`, `version`                           | Inventory, `RefreshServerStatus`, `Hello`                             | `storage:read`, `cluster:read` |
| `install`, `uninstall`, `plugin add/remove`, `debug`          | Out of scope; detected version and plugins are shown                  | none                           |

Every form shows its **Velero CLI equivalent** live (a copyable `velero ...` line); fields with no CLI flag are listed as notes rather than given an invented one.

**Velero support window**: primary **v1.18.4**, oldest supported **v1.16.2** (primary minus two minors). The Velero Go types are imported from the pinned release (module path stays `github.com/vmware-tanzu/velero`). The pin lives in `packages/shared/src/velero-support.ts`, the `Makefile` and ADR-002; change them together. A cluster newer than the primary shows a warning; older than the window, or unparseable, has commands refused until Velero is upgraded.

### 3.11 REST API

Base path `/api/v1`, JSON, OpenAPI 3.1 generated from the controllers into `server/openapi.yaml` (134 operations; see [`docs/API.md`](docs/API.md)). Errors are RFC 9457 `application/problem+json`; every response has `X-Request-Id`; lists use cursor pagination (`limit` up to 200). Writes answer `202 {commandId}`. Probes: `/healthz` (process only), `/readyz` (Postgres and Redis); `/metrics` is on its own port.

---

## 4. Using the product

### 4.1 Fleet overview

The home page shows fleet totals, four charts, a health map (one tile per cluster, most urgent first), the **needs attention** list and the cluster table (filter by name, status, or a _group_: a cluster label such as `env=prod`).

![Fleet overview with charts](docs/images/10-fleet-overview.jpg)

| Chart                               | Source      | Shows                                                 |
| ----------------------------------- | ----------- | ----------------------------------------------------- |
| Backups per day, last 7 days        | reports API | Stacked outcomes, success rate in the title           |
| Backups by status                   | fleet data  | Donut of backup phases                                |
| Cluster health                      | fleet data  | Donut of healthy, warning, critical, offline clusters |
| Namespaces without a backup in 48 h | reports API | Per cluster                                           |

Health: _critical_ = latest backup failed or storage unavailable; _warning_ = agent disconnected, invalid schedule or partially failed backup; _offline_ = not enrolled or disabled. Totals and the attention list always cover the whole fleet; a figure is shown as unknown rather than as a partial sum when you may not read some clusters.

Use the **cluster switcher** in the header to jump to any cluster. **All backups / All restores / All schedules** list every cluster you may read (latest 50 rows per cluster, at most 25 clusters per request, each read with your own permissions).

### 4.2 A cluster

Tabs: Overview, Backups, Restores, Schedules, Storage, Workloads, Events, Activity, Access, Settings.

![Cluster overview](docs/images/12-cluster-overview.jpg)

The overview shows health, Kubernetes, Velero, agent and chart versions, the agent policy (set by the cluster owner), the restore-approval switch and the backup storage locations. A banner appears when the Velero version is outside the compatibility window.

### 4.3 Backups

**Backups** lists with filters (name, phase, origin) and sort, shows duration, expiry, namespaces, item counts and problem counts. Open one for its spec, status, warnings and errors, resource list, volumes (including file-system backup and snapshot details), logs, and **Restore from this backup**.

![Backups](docs/images/13-backups.jpg)

**Create backup** is a four-step wizard (what to back up, storage and volumes, options, review) with the live Velero CLI equivalent on the right.

![Backup wizard](docs/images/19-backup-wizard.jpg)

Deleting one or several backups needs Cluster Admin, a typed confirmation and sudo.

### 4.4 Restores

_Restore_ on a backup opens a four-step wizard: source (a backup or a schedule's latest), scope (namespaces, `source:target` mapping, resources, selectors, cluster-scoped), options (existing-resource policy, volumes, node ports, status), review. Cluster-scoped restore is off where the agent policy forbids it, with the reason shown. If the organization requires approval, the restore waits for another person.

![Restore wizard, source step](docs/images/20-restore-source.jpg)

The review step shows what will be touched and the risks the browser can name: Kubernetes version drift since the backup, overwrite with "update", cluster-scoped resources, and persistent volumes needing the same storage classes. You must tick that you understand them. Restoring needs a typed confirmation and sudo.

![Restore review with the risk list](docs/images/21-restore-review.jpg)

When you name target namespaces, a `CheckNamespaces` command reports which already exist, answering only for the names you give so a limited user cannot list namespaces they may not see.

### 4.5 Schedules

Create from a cron expression (checked by the browser, the server and the agent; Velero stays the authority), **Run now**, edit, **Pause**, **Resume**, delete. A schedule is authorized as the backups it will make. A paused schedule makes none until resumed. Names are limited to 48 characters because its backups are `<name>-<14-digit stamp>`.

![Schedules](docs/images/14-schedules.jpg)

### 4.6 Storage

Backup storage locations and volume snapshot locations per cluster, with state and last validation. Credentials are **write-only**: they are sent to the agent once, written to a Secret in Velero's namespace, kept in server memory only until the command finishes, and never shown, logged or stored in plain text. If a command must be redelivered after a restart the credential is gone and the command fails with "submit the change again" instead of sending a location without it.

![Storage](docs/images/15-storage.jpg)

### 4.7 Reports

Success rate over time, namespace coverage ("which namespaces have no recent backup") and RPO compliance, per cluster. **Download CSV** or **Download PDF** (generated by `pdfkit`, pure JavaScript, so it works air-gapped).

![Reports](docs/images/17-reports.jpg)

### 4.8 Cluster settings and access

Settings hold name, labels, **environment type** (production, staging, development, dr, other), an informational **API endpoint**, an **owner** and a Grafana URL template; **Credentials and removal** holds rotate certificate, disable and delete (backups in the storage location are never touched).

![Cluster settings](docs/images/16-cluster-settings.jpg)

Access lists role bindings and grants a role to a person or team for the whole cluster or named namespaces. Owners and Admins are Cluster Admin everywhere and are not listed.

![Access](docs/images/18-access.jpg)

### 4.9 Organization administration

Left menu, Owner and Admin only: **Members** (invitations by email, or a link to copy when no SMTP server is configured), **Teams**, **Single sign-on** (issuer, client, group claim, group-to-team mapping), **Security**, **Alerts**, **Audit log**, **API tokens**.

![Security settings](docs/images/22-security-settings.jpg)

Security: require two-step verification for every member (admins always need it), allow backup content download (off by default), require approval of restores, audit retention days and whether to export before deleting.

![Alerts](docs/images/24-alerts.jpg)

Alert rules watch for a failed backup, a missed schedule, a disconnected agent, an unavailable storage location or a backup about to expire, and notify the chosen channels.

![Audit log](docs/images/23-audit-log.jpg)

The audit log filters by actor, action, cluster, outcome and dates, exports CSV, and **Export configuration** downloads the secret-free configuration record (§6.5).

### 4.10 UX rules

Destructive actions need a typed confirmation plus sudo. Actions disabled by RBAC, agent policy, Velero version or a disconnected cluster stay visible but disabled, with the reason on hover. Every queued command shows a toast linking to its live status. Times are shown in your timezone with UTC on hover. Dark and light themes, keyboard accessible, no external fonts or CDNs.

---

## 5. Repository and development

### 5.1 Layout

The repository hosts two applications. `vfm/` is this product. `apps/` and `libs/` are the legacy Velero UI (§10) and are not touched by VFM.

| Path (under `vfm/`)     | Contents                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `proto/`                | Agent-to-control-plane protocol (a contract); generated code is committed                              |
| `agent/`                | Go agent; `cmd/agent`, `cmd/loadtest`, `internal/*`, `test/chart`, Dockerfile                          |
| `server/`               | NestJS control plane: REST API, agent gateway, RBAC, audit, alerts, reports; `prisma/`, `openapi.yaml` |
| `web/`                  | React 19 single-page application                                                                       |
| `packages/shared/`      | Types, permission matrix, Velero support window, shared by server and web                              |
| `deploy/quickstart/`    | One-box Docker Compose (this guide)                                                                    |
| `deploy/dev/`           | Dev compose (Postgres, Valkey, MinIO, Mailpit, Dex) and kind clusters with Velero                      |
| `deploy/helm/`          | Charts `vfm-control-plane` and `vfm-agent`                                                             |
| `deploy/airgap/`        | Bundle, image list, `verify-airgap.sh`, `verify-upgrade.sh`                                            |
| `deploy/observability/` | Grafana dashboard and Prometheus alert rules                                                           |
| `e2e/`                  | Golden paths against real kind, Velero and MinIO; simulated clusters                                   |
| `docs/`                 | Generated `API.md` and `RBAC.md`, and the screenshots in `docs/images/`                                |

Three files are contracts: `proto/`, `server/prisma/schema.prisma` and `server/openapi.yaml`. Change them deliberately, run `make gen`, and record the change under §8. CI fails if the committed `openapi.yaml` differs from what the decorators produce.

Tooling: pnpm 10 (via corepack) rooted at `vfm/`, never at the repository root (which is npm and Nx); Go 1.27; `buf`; `make` (`make` alone lists targets). The product name lives in one constant per package (`packages/shared/src/product.ts`, `agent/internal/config/product.go`); change the two together.

### 5.2 Running each service

All commands run from `vfm/` unless stated. Run `make setup` once (installs workspace dependencies).

| Service                 | Command                                                                                                                                  | Result                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Everything in Docker    | `docker compose up -d --build` at the repository root (§2)                                                                               | UI and API on :3000, gateway on :8443                                             |
| Backing services        | `docker compose --env-file deploy/dev/dev.env -f deploy/dev/docker-compose.yml up -d --wait`                                             | Postgres :55432, Valkey :56379, MinIO, Mailpit, Dex (loopback only)               |
| Control plane           | `cd server && cp .env.example .env` (set `VFM_MASTER_KEY` with `openssl rand -base64 32`), `pnpm exec prisma migrate deploy`, `pnpm dev` | http://localhost:3000, metrics :9090                                              |
| Web UI                  | `pnpm --filter @vfm/web dev`                                                                                                             | http://localhost:5173, talks to :3000                                             |
| Agent in a cluster      | UI **Clusters -> Add cluster**, run the printed Helm command                                                                             | (§2 steps 7 to 10)                                                                |
| Agent out of cluster    | `cd agent && go run ./cmd/agent -dev -kubeconfig ~/.kube/config -control-plane-address=... ` with the CA and token                       | for development                                                                   |
| Real Velero for testing | `make dev-up` (two kind clusters, needs raised inotify limits) or `VFM_DEV_SOLO=1 make dev-up` (one cluster, no root)                    | kind with Velero v1.18.4 and MinIO                                                |
| Development accounts    | `pnpm --filter @vfm/server run build && pnpm --filter @vfm/server run seed`                                                              | an admin, orgs `acme` and `globex`, a user per role; refuses to run in production |

In production the control plane serves the built UI itself, so there is no separate web process. A fresh database shows **Setup** in the UI.

### 5.3 Quality gates

`make test` (unit, TypeScript and Go), `make lint` (eslint, prettier, golangci-lint, buf), `pnpm -r typecheck`, `pnpm --filter @vfm/server test:e2e` (needs the dev stack and a `vfm_test` database), `node e2e/golden.mjs` (13 golden paths against real Velero). Go `-race` needs a C compiler and runs in CI only. The agent chart has render tests that diff its RBAC against the plan, and the control-plane chart has a hardening test.

A green suite is not proof the service works: also build and run the shipped artifact (`pnpm run build`, `node server/dist/main.js`) and exercise the feature over HTTP.

### 5.4 Simulated clusters for demos

`e2e/sim-clusters.mjs` creates clusters named `sim-*` and prints a `loadtest` command that brings them online. They are agents from `agent/cmd/loadtest` with generated inventories and **no Velero behind them**: backups, schedules and charts have data, but commands do nothing real. The screenshots in this document use that approach against the Docker quickstart (control plane at `control-plane:8443` on the compose network). The simulator needs `GATEWAY_ENROLL_PER_MINUTE=100000` for large runs; for five clusters the default is enough.

### 5.5 Agent

One agent per cluster; it enrols, holds the mTLS stream and runs commands. Settings are environment variables, overridden by flags, validated at start (one failure names every offending setting, never its value).

| Variable (flag)                                                         | Default                                                        | Notes                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `VFM_CONTROL_PLANE_ADDRESS`                                             | required                                                       | `host:port` or `https://` URL; plaintext schemes and embedded credentials rejected |
| `VFM_CONTROL_PLANE_CA_FILE`, `VFM_SERVER_NAME`                          | empty, host                                                    | The CA the agent pins until enrolled; TLS name if different from the host          |
| `VFM_ENROLLMENT_TOKEN`                                                  | empty                                                          | One-time token. **Environment only**, never a flag, never logged                   |
| `VFM_CREDENTIALS_SECRET`, `VFM_POLICY_CONFIGMAP`, `VFM_STATE_CONFIGMAP` | `vfm-agent-credentials`, `vfm-agent-policy`, `vfm-agent-state` | Identity Secret; owner policy (read-only, reloaded every 30 s); idempotency cache  |
| `VFM_VELERO_NAMESPACE`, `VFM_NAMESPACE`                                 | `velero`, `vfm-system`                                         | Where Velero runs; where the Lease, Secret and ConfigMaps live                     |
| `VFM_HEALTH_ADDR`, `VFM_METRICS_ADDR`                                   | `:8081`, `:9090`                                               | `/healthz`, `/readyz`; `/metrics`                                                  |
| `VFM_LEADER_ELECTION`, `VFM_LEASE_*`                                    | `true`, 15 s/10 s/2 s                                          | Lease named `vfm-agent`                                                            |
| `VFM_HEARTBEAT_INTERVAL`, `VFM_SHUTDOWN_TIMEOUT`                        | `15s`, `20s`                                                   |                                                                                    |
| `VFM_DEV`, `VFM_KUBECONFIG`                                             | `false`                                                        | Out-of-cluster development only                                                    |

Behaviour: a Lease elects one leader, only the leader dials out, and losing the Lease ends the process cleanly so the standby takes over. `/healthz` never touches the Kubernetes API (a liveness probe that failed during an API hiccup would restart every agent at once); `/readyz` reports Kubernetes reachability and leadership. The config object is `slog.LogValuer`, so logging it whole cannot leak a value. Metrics: `vfm_agent_leader`, `vfm_agent_build_info`, plus Go runtime and process collectors.

**Agent RBAC** is exactly: cluster-wide read on nodes, namespaces, pods, PVCs, events and `get` on `pods/log`; full verbs on a fixed list of `velero.io` resources and read on the rest, in Velero's namespace only; Secrets `create/update/get` in Velero's namespace only; Lease, own Secret and ConfigMaps in `vfm-system`. No cluster-wide Secret access, no `exec`, no wildcards. Secret `create` cannot be limited by name in Kubernetes, which is accepted risk A-2.

Build and test: `cd agent && go build ./... && go vet ./... && go test ./...`, `golangci-lint run ./...`, `govulncheck ./...`, `docker build -t vfm-agent:local .` (distroless, non-root, read-only root filesystem).

### 5.6 Control plane

NestJS on Node 22, TypeScript strict, Prisma 7 over the `pg` adapter (the pool is ours to size), Redis through `ioredis`, gRPC through `@grpc/grpc-js`, `pino` logs, `prom-client`-compatible metrics, `nodemailer`, `pdfkit`, `ldapts`.

- Configuration is zod-validated in `src/config/env.schema.ts`, the authoritative variable list; a bad value stops the process naming the variable, never its value.
- `redact()` (`src/common/redact.ts`) is the single redaction point, used before logging and before persisting command payloads or audit details.
- Authentication is deny-by-default through global `SessionGuard`, `CsrfGuard` and `SudoGuard`; a route is public only with `@Public()`. Security headers and a strict CSP apply to the API and the served SPA alike; HSTS in production.
- Request bodies over 1 MB answer 413; malformed JSON answers 400 with a fixed sentence.
- The server image carries the API, the gateway and the built web app (`WEB_DIST_DIR`); non-root, read-only root filesystem, no capabilities.

---

## 6. Operations

> **Verification status.** Commands and manifests here were rendered and tested (chart tests, `helm lint`, unit and end-to-end suites, a built-image smoke test, golden paths on a single-node kind cluster with Velero v1.18.4). No step was run on a production Kubernetes cluster. Your first install is the first real one; the restore drill (§6.8) is how you confirm it.

### 6.1 Install the control plane (Helm)

You bring: Kubernetes 1.27+, PostgreSQL 15+, Redis/Valkey 7+ **with a password**, and DNS names for the UI and for the agents.

```bash
kubectl create namespace vfm-system
kubectl -n vfm-system create secret generic vfm-control-plane \
  --from-literal=database-url='postgresql://vfm:CHANGE_ME@postgres.example:5432/vfm?sslmode=require' \
  --from-literal=redis-url='rediss://:CHANGE_ME@redis.example:6380' \
  --from-literal=master-key="$(openssl rand -base64 32)"
```

**Back the master key up somewhere that is not the cluster.** It encrypts every stored secret (OIDC client secrets, MFA secrets, channel secrets, the CA key). Lose it and those are unreadable. In production the server refuses to start with a Redis URL that has no password; `rediss://` is recommended, plain `redis://` only warns.

```yaml
# my-values.yaml
secrets: { existingSecret: vfm-control-plane }
gateway:
  publicAddress: agents.vfm.example.com:8443 # what agents dial
  hostnames: agents.vfm.example.com # goes into the gateway certificate
  service: { type: LoadBalancer }
config: { publicUrl: https://vfm.example.com, apiPublicUrl: https://vfm.example.com }
ingress:
  {
    enabled: true,
    className: nginx,
    host: vfm.example.com,
    tls: { secretName: vfm-example-com-tls },
  }
```

```bash
helm upgrade --install vfm vfm/deploy/helm/vfm-control-plane -n vfm-system -f my-values.yaml
kubectl -n vfm-system logs deploy/vfm-control-plane | grep -ao 'token\\":\\"[A-Za-z0-9_-]*'   # the one-time setup token
```

Two things the chart cannot check for you:

1. **The agent gateway is passed through, not terminated.** It requires a client certificate signed by the internal CA; a proxy that terminates TLS strips it and no agent connects. Use a `LoadBalancer` Service, ingress-nginx `ssl-passthrough`, or a Gateway API `TLSRoute` in passthrough mode (examples in `deploy/helm/vfm-control-plane/examples/`: `ingress-nginx-https.yaml` for the UI, `gateway-api-tls-passthrough.yaml`, `ingress-nginx-passthrough.yaml`, `loadbalancer-values.yaml` for the gateway).
2. **Postgres connections**: replicas x `config.databasePoolMax` (plus the migration job) must stay under the database's `max_connections` (100 by default). The chart default is 3 replicas (HPA 3 to 6) at 15 connections each; raise `max_connections` before raising either number. A pool larger than the database allows shows up as HTTP 500 "too many clients".

The chart also provides a PodDisruptionBudget, a NetworkPolicy, a pre-upgrade migration Job, an optional retention CronJob and hardened pod and container security contexts, and it ships a rendered-manifest hardening test.

### 6.2 Configuration reference

The chart sets these; set them directly if you deploy without it. Secrets come from a Secret, never a file. The authoritative list is `server/src/config/env.schema.ts`.

| Variable                                                                                                   | Default             | Meaning                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `REDIS_URL`, `VFM_MASTER_KEY` (secret)                                                     | required            | PostgreSQL; Redis/Valkey (password required in production); 32 random bytes, base64           |
| `VFM_MASTER_KEY_PREVIOUS`                                                                                  | -                   | Comma-separated retired keys, kept while rotating                                             |
| `PUBLIC_URL`, `API_PUBLIC_URL`                                                                             | localhost           | Where users reach the UI and the API (email links, the OIDC redirect)                         |
| `PORT`, `METRICS_PORT`, `HOST`                                                                             | 3000, 9090, 0.0.0.0 | Listeners; metrics are never on the public Service                                            |
| `GATEWAY_ENABLED`, `GATEWAY_PORT`                                                                          | true, 8443          | The agent gateway                                                                             |
| `GATEWAY_PUBLIC_ADDRESS`, `GATEWAY_HOSTNAMES`                                                              | localhost           | What agents dial; names in the gateway certificate                                            |
| `TRUST_PROXY`                                                                                              | false               | Proxies in front (number, `true` or subnet); needed for correct per-address rate limits       |
| `DATABASE_POOL_MAX`                                                                                        | 30 (chart 15)       | Connections per replica                                                                       |
| `AGENT_MESSAGES_PER_SECOND`, `AGENT_MESSAGE_BURST`                                                         | 100, 1000           | Per agent stream; over it the stream closes and the agent reconnects                          |
| `GATEWAY_ENROLL_PER_MINUTE`, `GATEWAY_ENROLL_MAX_INFLIGHT`                                                 | 30, 16              | Enrol limits per source address and per replica                                               |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`                         | unset               | Email. Unset: invitations are refused with 503                                                |
| `LDAP_URL`, `LDAP_START_TLS`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_SEARCH_BASE`, `LDAP_USER_FILTER` | unset               | LDAP sign-in (§3.6)                                                                           |
| `ALERT_EVAL_INTERVAL_SECONDS`                                                                              | 30                  | Alert evaluation; 0 turns it off                                                              |
| `ALERT_WEBHOOK_ALLOW_PRIVATE`, `OIDC_ALLOW_PRIVATE`                                                        | false               | Allow private-network webhook or identity-provider addresses (on-prem)                        |
| `DOWNLOAD_CACHE_TTL_DAYS`                                                                                  | 7                   | How long fetched logs and results are cached                                                  |
| `RETENTION_INTERVAL_HOURS`, `RETENTION_AUDIT`                                                              | 24, true            | The daily purge; `0` turns it off                                                             |
| `AUDIT_EXPORT_DIR`                                                                                         | unset               | Where audit events are written (CSV) before deletion; unset means those orgs are never purged |
| `WEB_DIST_DIR`                                                                                             | set in the image    | Built UI directory; unset serves the API only                                                 |
| `OTEL_ENABLED`                                                                                             | false               | Tracing hook; needs `@opentelemetry/sdk-node` installed                                       |
| `DEV_DISABLE_MFA`                                                                                          | false               | Local development only; refused when `NODE_ENV=production`                                    |

### 6.3 Upgrades and rollback

```bash
helm upgrade vfm vfm/deploy/helm/vfm-control-plane -n vfm-system -f my-values.yaml --set image.tag=NEW
```

1. A pre-upgrade Job runs `prisma migrate deploy` and must succeed before any pod changes.
2. The Deployment rolls with `maxUnavailable: 0`: new pods are ready before old ones leave. Agents reconnect to whichever replica answers; commands in flight are redelivered and the agent does not run one twice.
3. **Migrations are expand-first**: a release only adds (columns, tables, nullable fields), so the previous release keeps working against the new schema. Removing something takes a second release. `migrations.test.ts` fails a migration that drops or renames without a reviewed exemption.
4. **Roll back** with `helm rollback`. Restore the database backup only if a migration itself went wrong.

Always take a database backup first. `deploy/airgap/verify-upgrade.sh` rehearses old image, migrate, new image under traffic.

### 6.4 Backing up VFM itself

Protect, in order: the **PostgreSQL database**, the **master key**, and your Helm values. Redis holds sessions and counters only; losing it signs everyone out and nothing more.

```bash
pg_dump --format=custom --file=vfm-$(date +%F).dump "$DATABASE_URL"
# restore:  pg_restore --clean --if-exists --dbname="$DATABASE_URL" vfm-YYYY-MM-DD.dump
```

VFM can also back itself up with Velero: if PostgreSQL runs in the cluster, quiesce it with a pre-hook (`pg_dump -Fc`) and schedule the `vfm-system` namespace with `defaultVolumesToFsBackup: true` and a TTL of 720 h. A managed database is backed up by its provider. **Restore order**: database, then the master-key Secret, then `helm upgrade --install`. The audit log is in the database and is included. Practise a restore before you need one.

### 6.5 Configuration export (FR-19)

**Administration -> Audit log -> Export configuration** (or `GET /api/v1/orgs/{orgId}/config-export`; Owner and Admin; audited as `config.export`) downloads one JSON file: organization settings, members and roles, teams, cluster metadata, role bindings, alert rules and the _names_ of notification channels. It contains **no** password hashes, MFA secrets, tokens, certificates or channel settings. It is a record for audit and rebuild, not a restore format: the way back is the database restore above, and a lost cluster re-enrols its agent.

### 6.6 Rotation

**`VFM_MASTER_KEY`.** Set a new key as `VFM_MASTER_KEY` and move the old one to `VFM_MASTER_KEY_PREVIOUS`; roll the replicas (everything still opens). `node dist/rewrap.js --dry-run` shows how many values are still on an old key per column; `node dist/rewrap.js` re-encrypts them (safe while the server is up, exits 1 listing anything it could not open). At `stale: 0` everywhere, drop the old key and roll again. Keep the old key backed up until a database backup taken before the re-wrap has aged out. Run inside a pod: `kubectl -n vfm-system exec deploy/vfm-control-plane -- node dist/rewrap.js --dry-run`.

**The internal CA.** Agents receive a PEM bundle at enrolment and at each renewal (every 7 days at most), so a second CA needs no re-enrolment. `node dist/ca-rotate.js stage` (new CA joins the bundle; `unstage` undoes it), wait one certificate lifetime (7 days), `promote` (new CA signs, old one retiring but trusted), wait another lifetime, `retire`. `status` prints each CA. `promote` and `retire` refuse before the wait is over (`--force` is logged). An agent offline longer than a lifetime must be re-enrolled. These commands run outside the API and are **not** in the audit log: keep their output with the change ticket.

**An agent's credentials.** On **Clusters**, _Rotate certificate..._, _Disable..._ and _Delete..._ revoke its certificate; the stream is closed and it cannot reconnect. Re-enrol with a new bootstrap token.

### 6.7 Retention, downloads, policies

- **Retention**: the audit table is append-only and only the Postgres role `vfm_audit_retention` can delete from it. By default the application's own login is a member, so the in-process daily job purges. To make the running application unable to erase its own trail, set `retention.audit=false` and run `node dist/retention.js` from a CronJob with a separate login that is a member. Without membership nothing is deleted. Run once by hand with `pnpm --filter @vfm/server run retention`.
- **Backup download** is off by default (§3.5). A cluster whose agent is `readOnly` refuses it.
- **Cluster-scoped restores**: the agent chart value `policy.allowClusterScopedRestore` (default `true`). Set it `false` and every restore must carry `includeClusterResources: false`; an unset value is refused because Velero treats it as true.

### 6.8 Restore drill (do this once, on a real cluster)

1. Install an agent on a non-production cluster that has Velero and real object storage.
2. Back up a namespace with a PVC holding known data (`sha256sum` it first); wait for `Completed`; read the logs in the UI.
3. Delete the namespace. Restore it from the UI (typed confirmation and sudo).
4. Check the pods run and the checksum matches. Repeat with namespace mapping (`demo -> demo-restored`).

### 6.9 Troubleshooting

**An agent will not connect** (symptom in the agent log):

| Symptom                                                               | Cause                                                                     | Fix                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `x509: certificate signed by unknown authority`                       | Wrong or missing `controlPlane.caBundle`, or a TLS-intercepting proxy     | Use the CA from _Add cluster_; exclude the gateway from interception |
| `transport: authentication handshake failed` / `tls: bad certificate` | A proxy or L7 balancer terminates TLS in front of the gateway             | Pass TLS through (§6.1)                                              |
| `connection refused` / timeout                                        | Gateway not reachable from the cluster, or egress blocked                 | Open egress to `host:8443`; check the NetworkPolicy `gatewayFrom`    |
| `Unauthenticated: ... token`                                          | Bootstrap token used, expired (24 h) or for another cluster               | _Add cluster_ again (or _New token_)                                 |
| `ResourceExhausted` on enrol                                          | `GATEWAY_ENROLL_PER_MINUTE` reached for that address                      | Wait a minute or raise the limit; the agent retries by itself        |
| Connects, then closed with `message rate limit exceeded`              | The agent exceeded `AGENT_MESSAGES_PER_SECOND`                            | Investigate the agent; raise the limit only if legitimate            |
| `Unauthenticated` after working                                       | Certificate revoked (disabled, rotated, deleted) or expired while offline | Re-enrol                                                             |
| `FailedPrecondition: fingerprint`                                     | The credentials now run in a different cluster                            | The agent was copied; enrol the new cluster separately               |
| `HTTP/2` or stream errors through a proxy                             | The proxy cannot carry long-lived HTTP/2                                  | Use a TCP/TLS passthrough path                                       |

The cluster page shows the last heartbeat; an agent silent for 45 seconds is marked Disconnected. An agent behind an HTTP proxy needs `proxy.httpsProxy`/`noProxy`; a proxy that cannot carry a long-lived HTTP/2 stream is an open question (a WebSocket fallback would be a later decision).

**The UI**: _everything is 503_ means PostgreSQL or Redis is unreachable (`/readyz` says which; nobody can sign in while Redis is down). _HTTP 500 "too many clients"_ is pool sizing (§6.1). _SSO fails_: the redirect URI must be exactly `<API_PUBLIC_URL>/api/v1/auth/oidc/callback`; for a private identity provider set `OIDC_ALLOW_PRIVATE=true`. _Invitations do not arrive_: `SMTP_HOST` unset or unreachable. _A report looks old_: reports are shared for 30 seconds by design.

**Commands**: _stuck in SENT_ means the agent is disconnected; it is redelivered on reconnect or becomes `TIMED_OUT` at its deadline. _A disabled button_ says why on hover (permission, agent policy or missing Velero capability). _Command succeeded but the backup failed_ are different things by design; read the backup's phase and logs.

### 6.10 Air-gapped installation

No CDN assets, no external fonts, no telemetry, no registry calls at runtime, no breached-password API (the list is bundled); agents dial only your control plane.

```bash
docker build -f vfm/server/Dockerfile -t ghcr.io/shubhambatra/vfm-control-plane:0.1.0 vfm   # from the repository root
docker build -t ghcr.io/shubhambatra/vfm-agent:0.1.0 vfm/agent
vfm/deploy/airgap/bundle.sh ./vfm-airgap-bundle      # chart packages, images.tar, images.txt, SHA256SUMS
```

The image list is **rendered from the charts** by `images.sh`, so it cannot drift. Not in the bundle because they are yours: PostgreSQL, Redis/Valkey, your ingress controller, and Velero with its plugin and node-agent images in each managed cluster (the dev environment pins the tested versions in `deploy/dev/versions.env`: Velero v1.18.4, AWS plugin v1.14.4).

On the disconnected side: `sha256sum -c SHA256SUMS`, `docker load -i images.tar`, retag and push to the private registry, then
`helm upgrade --install vfm ./vfm-control-plane-0.1.0.tgz -n vfm-system --create-namespace -f my-values.yaml --set image.repository=registry.internal/vfm/vfm-control-plane --set 'imagePullSecrets[0].name=internal-registry'`.
For each cluster use the agent command from _Add cluster_ but with the local `./vfm-agent-0.1.0.tgz` and `--set image.repository=registry.internal/vfm/vfm-agent`. In a closed network set `config.smtp.*` to an internal relay (or leave it unset and add people through SSO), and `OIDC_ALLOW_PRIVATE`/`ALERT_WEBHOOK_ALLOW_PRIVATE` for private addresses. Time must be in sync on both sides.

`vfm/deploy/airgap/verify-airgap.sh` (never pulls) proves, on a Docker `--internal` network with no route out: the migration and the control plane run hardened (read-only filesystem, no capabilities, non-root); production mode refuses a Redis without a password; the UI is served with a strict CSP and no CDN host; first-run setup, MFA, an organization and **Add cluster** work; an agent enrols over TLS against the internal CA and connects over mTLS; and no password, key or setup token leaks into logs. It does **not** prove Kubernetes behaviour (no `helm install` against a cluster, NetworkPolicy enforcement or registry pull), uses a protocol-level stand-in rather than the real agent, and does not cover Velero's own air-gap needs.

### 6.11 Observability of VFM itself

- **Metrics** on a separate listener (`METRICS_PORT`, `/metrics`, never public), per replica, all prefixed `vfm_`; labels are enums and route templates only, so series count is fixed by the API's size, not by clusters or users.

| Metric                                                                                                 | Meaning                                                     |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `vfm_agents_connected`, `vfm_agent_stream_connects_total{kind}`, `vfm_agent_stream_ends_total{reason}` | Agent streams open, opened, ended                           |
| `vfm_sse_subscribers`, `vfm_sse_connects_total`                                                        | Browser event streams                                       |
| `vfm_commands_total{op,status}`, `vfm_command_duration_seconds{op,status}`                             | Command transitions and request-to-final latency            |
| `vfm_commands_unfinished{status}`                                                                      | Work-queue depth (read from the database at most every 5 s) |
| `vfm_http_request_duration_seconds{method,route,status_class}`                                         | REST latency                                                |
| `vfm_alert_deliveries_total{kind,ok}`, `vfm_rate_limited_total{name}`                                  | Alert delivery and rate-limit refusals                      |
| `vfm_retention_deleted_total{kind}`, `vfm_retention_runs_total{status}`                                | Retention job                                               |

`deploy/observability/` has a 16-panel Grafana dashboard and seven Prometheus rules (metrics missing, p95 over 300 ms, 5xx ratio, command backlog, agents flapping, event-loop lag, alert delivery failing); enable them with `metrics.dashboard.enabled`, `metrics.prometheusRule.enabled`, `metrics.serviceMonitor.enabled`. A test fails if either file queries a metric that does not exist. **Neither has been imported into a real Grafana or run through `promtool`.**

- **Logs** are JSON, one object per line, on stdout, from an allowlist of fields. A request line carries `req.id` (also `X-Request-Id`), method and path (**query string dropped**, it can hold one-time codes), peer address, the first 200 characters of the user agent, status and `responseTime`. Cookies, `Authorization`, CSRF tokens and `Set-Cookie` are redacted. `/healthz`, `/readyz` and `/metrics` are not logged. A lost database or cache logs one warning and answers 503 with `Retry-After`.
- **Tracing** is off by default: `withSpan` wraps command delivery; install `@opentelemetry/sdk-node` and set `OTEL_ENABLED=true` and the standard OTLP variables. A tracing failure never stops the server. Not verified end to end against a collector.

### 6.12 Resilience and scale

**Behaviour under failure** (tested with a TCP fault proxy against real Postgres, Redis and agent link):

| Failure                            | Promise                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL goes away               | `/healthz` stays 200, `/readyz` 503, users get 503 with `Retry-After` (no stack, no driver text), the pool reconnects, a command acked before the outage finishes exactly once |
| Redis goes away                    | Nobody is let in (503, not 200), the process stays up, agent streams are untouched and their results applied afterwards                                                        |
| Partition between agent and server | A sent but unacked command arrives again after reconnect (at-least-once), one issued during the partition arrives once, oldest first                                           |
| A slow agent                       | Only its own commands wait; other clusters are served in under a second; past the deadline it is `TIMED_OUT` and a late result is ignored                                      |

Not tested: a real two-replica kill with exactly-once proof, a real Postgres or Redis restart (server-side recovery such as WAL replay), transport backpressure, clock skew.

**Targets** (200 connected clusters, 100 concurrent users): list endpoints p95 under 300 ms; command reaches the agent p95 under 1 s; resource event reaches a browser p95 under 3 s; agents reconnect within 60 s; agent footprint under 100 MiB and 100m CPU on a 5 000-pod cluster; zero-downtime upgrades; survives loss of one replica.

**Measured** with a simulator on one 16-core host (the simulator and all replicas share it, so it understates separate machines; one 5-minute run per row; the simulator changes inventory faster than real clusters):

| Replicas (pool each) | Lists p95 (worst) | Command to agent p95 | Event to browser p95 | Request errors | All targets met |
| -------------------- | ----------------- | -------------------- | -------------------- | -------------- | --------------- |
| 1 (30)               | 275 to 438 ms     | 2 062 ms             | 883 ms               | 2 to 13        | no              |
| 2 (30), three runs   | 85 to 722 ms      | 132 to 2 224 ms      | 294 to 1 201 ms      | 0 to 12        | once in three   |
| 4 (15)               | 130 to 295 ms     | 218 ms               | 370 ms               | 0              | yes             |

So **two replicas are not reliably enough; four met every target with margin** (the fleet page, at 295 ms, is closest to the line). The chart defaults to 3 (HPA 3 to 6), a value between the two that was not itself measured. A single replica also showed ingest transactions failing under load (220 in one run; the server recovers by asking the agent for a new snapshot, so no data is lost) because ingest and users share one pool; a separate pool is an open design choice. Reports are the heaviest requests, hence the 30 s shared answer (ADR-045). **Not exercised**: 50 000 Velero objects and 20 000 pods per cluster, the real agent's footprint, a real kill of a replica proving exactly-once. The simulator is `agent/cmd/loadtest`: `go build -o loadtest ./agent/cmd/loadtest; ./loadtest --fixture fixture.json --agents 200 --users 100 --duration 5m --report out.json` (exit 0 when every target held, 1 when one failed, 2 on usage errors; provision a fixture with `server/scripts/loadtest-provision.ts`; bootstrap tokens are single use, so re-provision between runs).

### 6.13 Release checklist (definition of done for v1)

| #   | Item                                                                  | Status                                                                             |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | 12 e2e golden paths on the primary and the oldest supported Velero    | Partial: all 13 pass on v1.18.4; oldest minor (v1.16.2) not run                    |
| 2   | No stubbed or mocked production code paths                            | In progress: envtest and Playwright not built                                      |
| 3   | Org-isolation tests cover every OpenAPI operation                     | Done (`security-matrix.e2e.test.ts`)                                               |
| 4   | At least 50 table-driven namespace-scope test cases                   | Done (66 cases)                                                                    |
| 5   | Credentials grep test (database dump, logs, audit, command payloads)  | Done                                                                               |
| 6   | Agent RBAC equals the specified rules, checked by rendering the chart | Done                                                                               |
| 7   | Threat model written, each mitigation verified                        | Done (§7)                                                                          |
| 8   | Load test meets the targets                                           | Partial: met with 2 and 4 replicas, not on one; 50 k objects and 20 k pods not run |
| 9   | Zero high or critical vulnerabilities in dependencies and images      | In progress: scans wired in CI; no green run seen; required checks are yours       |
| 10  | Air-gapped install verified with egress blocked                       | Done (`verify-airgap.sh`)                                                          |
| 11  | Upgrade from the previous version without downtime                    | Done (`verify-upgrade.sh`)                                                         |
| 12  | Docs                                                                  | Done (this document, generated `API.md` and `RBAC.md`)                             |
| 13  | Grafana dashboard and alerts for VFM itself                           | Partial: shipped and tested, not imported into a real Grafana                      |
| 14  | Restore drill on a real non-kind cluster                              | Not started (needs a real cluster)                                                 |

Last full results: TypeScript unit 132 + 1141 + 511 passing, server e2e 670 passing, `go vet`, `go test` and golangci-lint clean, 13 of 13 golden paths. Not run here: the Go race detector (CI only), the oldest-Velero matrix, a real non-kind cluster. The SOW gap-closure work (§1) was typechecked and linted but no tests were written for it.

---

## 7. Security

### 7.1 What is protected

Customer clusters (a restore writes into production; a delete removes recovery points); backup data in the customer's storage (never proxied; VFM only holds credentials it was told to write into a Secret); cloud credentials in Velero's namespace; platform secrets (`VFM_MASTER_KEY`, the CA key, OIDC secrets, channel secrets, MFA secrets); identity (sessions, tokens, MFA); org isolation; the audit log.

### 7.2 Trust boundaries

1. Internet to ingress and API: anyone; authenticated by session cookie or API token.
2. Browser content: agent-supplied and log-derived text is **data, never markup**.
3. API to Postgres and Redis: one trust domain, reachable only from the control plane's network.
4. Agent to gateway: the agent is **semi-trusted**. A compromised cluster must not corrupt another cluster's data or inject script into the UI; identity is the client certificate, nothing the agent says.
5. Gateway to agent: the agent does not trust the control plane for the owner's policy; the owner's ConfigMap decides.
6. Control plane to outbound destinations: an org Admin names the URL, so the server connects from inside the operator's network (SSRF controls apply).

### 7.3 Controls by component (STRIDE)

| Component                 | Main controls                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser and SPA           | Strict CSP (no inline scripts, no third-party origins), HSTS, X-Frame-Options DENY, no HTML sinks (`dangerouslySetInnerHTML` and friends are grepped for), ANSI parser drops everything but colours                                                                |
| REST API and sessions     | argon2id, breached-password check, httpOnly Secure SameSite cookies, CSRF, per-account and per-address throttles, a shared 5-failure 10-minute budget for the MFA code and the sudo password, 1 MB body cap, rate limits on setup, invites, OIDC, reports, exports |
| API tokens                | Hashed, shown once, narrowing only, opt-in per route, refused for sudo operations                                                                                                                                                                                  |
| RBAC and org isolation    | Pure deny-by-default engine, Prisma org-scope extension, 404 for hidden objects, a security matrix test over every OpenAPI operation                                                                                                                               |
| Audit                     | Append-only trigger, no foreign keys, actor, request id, outcome                                                                                                                                                                                                   |
| Secrets at rest           | AES-256-GCM envelope encryption with key ids, re-wrap CLI, credentials never stored or logged, `redact()` chokepoint                                                                                                                                               |
| Gateway, enrolment, CA    | One-time hashed bootstrap tokens, mTLS, 7-day certificates, deny-list, per-minute stream re-check, per-address enrol limit, CA rotation with overlap                                                                                                               |
| Agent                     | Typed allowlist, owner policy, minimal RBAC, no exec, redacted logs, signed-URL fetch refuses loopback and metadata addresses and follows no redirect, size caps                                                                                                   |
| Postgres, Redis           | Network-restricted; Redis password enforced in production; redundant 503 behaviour on outage                                                                                                                                                                       |
| Outbound connections      | Webhook and OIDC destinations validated; the address connected to is the address checked; redirects not followed                                                                                                                                                   |
| Live logs, downloads, SSE | Per-namespace permission, audited, not stored; signed links short-lived and never stored; per-user SSE cap                                                                                                                                                         |
| Supply chain              | Actions pinned by SHA, `govulncheck` pinned, image scanning and SBOMs in CI, non-root read-only containers with dropped capabilities and a seccomp profile                                                                                                         |

Public routes, each with a reason: `/auth/setup` (first-run, gated by a one-time token), `/auth/login`, `/healthz`, `/readyz`, OIDC provider listing, start and callback, and `/invites/register` (the invitation token is the credential). Adding one needs a documented reason; `grep -rn "@Public" server/src` must match.

### 7.4 Manual checks (at install and each upgrade)

| #   | Check                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1 | Postgres and Redis are unreachable from outside the control plane; Redis has a password (and ideally TLS)                                                                   |
| M-2 | The control-plane container is non-root, read-only filesystem, capabilities dropped, seccomp profile set                                                                    |
| M-3 | The API is served only over TLS with HSTS (`curl -sI https://.../healthz`)                                                                                                  |
| M-4 | The SPA carries the same CSP and headers as the API                                                                                                                         |
| M-5 | No untrusted-HTML sink in the web app (`grep -rnE "dangerouslySetInnerHTML\|innerHTML\|eval\(\|javascript:\|window\.open\|document\.write" web/src` is empty outside tests) |
| M-6 | Every route is guarded; `@Public` matches the list above                                                                                                                    |
| M-7 | `VFM_MASTER_KEY` and the CA key are backed up separately from the database                                                                                                  |

### 7.5 Network and security checklist for operators

Postgres and Redis reachable only from the control plane's namespace; Redis password (enforced) and ideally TLS; metrics port never exposed; `TRUST_PROXY` set to the real number of proxies; the gateway Service is all agents need (narrow `loadBalancerSourceRanges` to your clusters); make the CI jobs required checks on the repository.

### 7.6 Accepted risks

| #   | Risk                                                                             | Why accepted, and what limits it                                                                                                        |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | A compromised agent can lie about its own inventory and policy to the UI         | It cannot reach another cluster or change what other users may do; the agent enforces its own policy whatever the UI shows              |
| A-2 | The agent can read and update every Secret in Velero's namespace                 | The plan requires Secret create/update/get there and Kubernetes cannot scope `create` by name; keep other secrets out of that namespace |
| A-3 | A user with `storage:write` can point a location at a private-range address      | Private ranges must stay allowed for on-prem storage; it needs sudo, the agent's policy and a NetworkPolicy are further layers          |
| A-4 | The audit write is best-effort after the response                                | A crash between response and insert loses one event; the request log with the request id still has the call                             |
| A-5 | A known email can be locked out for 15 minutes by 10 bad logins                  | Timed, never permanent; the owner is emailed. A permanent lock would be a worse denial of service                                       |
| A-6 | Org Admins can register an IdP and JIT-create accounts for addresses they assert | Linking into an existing account needs an existing membership, and an invitation is accepted only with its emailed token                |

Gaps found by the review and closed: container hardening and a chart (G-1), rate limits (G-3), cluster-scoped restore policy (G-4), the SPA served under the same CSP (G-5), a route-by-route auth test (G-6), retention (G-8), key re-wrap (G-9), a per-agent message budget (G-10), an enrol limit (G-11), CA rotation (G-12), Redis authentication at start-up (G-13), CI pinning and scanning (G-15). Open: G-7 is accepted risk A-4; G-14 (the per-user SSE cap is per replica, so N replicas multiply it) is documented.

---

## 8. Decisions

Architecture decision records, one to three lines each. **ADR numbers are cited from code comments**, so they are kept stable. New decisions get the next number here; supersede rather than edit.

| ADR | Decision                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | Adopt the planned stack: Go agent (controller-runtime, client-go, gRPC via buf, slog), NestJS control plane (Postgres via Prisma, Redis/Valkey, argon2, otplib, openid-client, zod, pino), React 19 + Vite. The six principles are binding invariants.                                          |
| 002 | Velero primary **v1.18.4**, oldest supported **v1.16.2**; the repository moved to `velero-io/velero` but the Go module path is still `github.com/vmware-tanzu/velero`.                                                                                                                          |
| 003 | Build VFM as a new `vfm/` subtree beside the legacy app, which violates P1 (reads clusters by kubeconfig) and is not extended. Only the hand-written Velero TypeScript models were copied as a starting point.                                                                                  |
| 004 | pnpm workspace rooted at `vfm/` (pnpm 10.20.0 via corepack); repository root stays npm and Nx.                                                                                                                                                                                                  |
| 005 | Defaults for the plan's open questions: self-hosted only; 200 clusters; assume HTTP/2 works; oldest Velero is primary minus two; backup download off by default.                                                                                                                                |
| 006 | Substitutions: `@prometheus-io/client` for `prom-client`, ESLint 10, drop `@nestjs/cli` (TypeScript peer conflict).                                                                                                                                                                             |
| 007 | Prisma 7 with the `pg` driver adapter, so the connection pool is ours to size across replicas.                                                                                                                                                                                                  |
| 008 | `mfa_recovery_codes` is a table so spending a code is one atomic `UPDATE ... WHERE used_at IS NULL`.                                                                                                                                                                                            |
| 009 | SHA-256 for recovery codes and API tokens (high-entropy, server-generated), argon2id for passwords.                                                                                                                                                                                             |
| 010 | Org scoping through a Prisma client extension (`inOrg`, `unscoped(reason)`); an `invites` table; M1 started before M0 exited.                                                                                                                                                                   |
| 011 | OIDC identity linking by `(provider, sub)`, then verified email only for existing members; JIT off by default; `oidc_identities` table.                                                                                                                                                         |
| 012 | RBAC is a pure engine in `@vfm/shared`; `role_bindings` has no cluster FK; deny by default and on doubt.                                                                                                                                                                                        |
| 013 | Audit is trigger-enforced append-only, written from response middleware, no FKs, nullable `org_id`; only `vfm_audit_retention` may delete.                                                                                                                                                      |
| 014 | API tokens: `vfm_` + 256 bits, hashed, bearer auth opt-in per route, narrowing only.                                                                                                                                                                                                            |
| 015 | The agent protocol contract: six proto files; Velero specs written field by field from the pinned Go types.                                                                                                                                                                                     |
| 016 | Internal CA, bootstrap tokens and cluster tables; `org_id` denormalised onto child tables so the org scope covers them.                                                                                                                                                                         |
| 017 | The agent's connection manager: the key is born in the cluster (ECDSA P-256, Secret-backed identity), backoff with jitter.                                                                                                                                                                      |
| 018 | Server-side stream registry: Redis routing with a 60 s TTL, one control channel for supersession and revocation.                                                                                                                                                                                |
| 019 | Command pipeline: the row is written before sending; pure state machine; every transition one conditional UPDATE; redelivery of unfinished commands on Hello.                                                                                                                                   |
| 020 | Agent chart, image and stream hardening: RBAC exactly as specified, values schema, non-root distroless image.                                                                                                                                                                                   |
| 021 | Agent inventory sync: eleven Velero kinds via the dynamic client, capability detection rerun on resync, a delta only after a completed snapshot.                                                                                                                                                |
| 022 | Ingest: snapshots assembled in memory and applied in one transaction; `velero_resources` with indexed phase and timestamps; SSE event stream.                                                                                                                                                   |
| 023 | Fleet and cluster overview; permissions evaluated in bulk; a section the caller may not read is `null`, never zero.                                                                                                                                                                             |
| 024 | Lists, detail pages and visibility: a scoped user sees a backup only if every namespace is in scope; 404 for hidden and missing alike.                                                                                                                                                          |
| 025 | Velero's per-backup files through `FetchDownload`, fetched inside the cluster; `BackupContents` is never proxied.                                                                                                                                                                               |
| 026 | Backup create, delete, run-now; strict typed fields; the strict `createCoverage` rule for scoped users.                                                                                                                                                                                         |
| 027 | Backup wizard with live CLI preview; pure form library; `GET .../access` reports what the user may do.                                                                                                                                                                                          |
| 028 | Restore create and delete; authorization covers both sides of a namespace mapping; sudo and no API tokens.                                                                                                                                                                                      |
| 029 | Restore wizard; additive `CheckNamespaces` command reports which named target namespaces exist, without disclosing others.                                                                                                                                                                      |
| 030 | Schedules are authorized as the backups they make; names at most 48 characters; cron checked in three places.                                                                                                                                                                                   |
| 031 | Storage credentials held in memory only until the command finishes; redelivery after a restart fails instead of sending without a credential.                                                                                                                                                   |
| 032 | Golden paths tested at the control plane with a scripted agent; the agent policy is folded into the UI's access answer.                                                                                                                                                                         |
| 033 | Core inventory is an allowlisted projection (no env vars, commands, volumes, annotations), stored in `velero_resources`.                                                                                                                                                                        |
| 034 | Namespace backup coverage computed by the control plane (badges `recent` within 48 h, `stale`, `none`, `scheduled`).                                                                                                                                                                            |
| 035 | Live log sessions are Redis state plus a channel, never a row; the agent starts on the first stream; no replay.                                                                                                                                                                                 |
| 036 | Log viewer: `@tanstack/react-virtual`, 50 000-line buffer, SGR-only ANSI parsing, 100 ms batching.                                                                                                                                                                                              |
| 037 | Alerts evaluate state every 30 s under a Redis lock; one open row per condition; no BullMQ yet.                                                                                                                                                                                                 |
| 038 | Channels: validated destinations, the connected address is the checked address, no redirects, nothing identifying stored outside the encrypted column.                                                                                                                                          |
| 039 | Reports: selection in the scoped client, arithmetic in pure code, capped reads with an `incomplete` flag, results limited to what the caller may read.                                                                                                                                          |
| 040 | Restore approval: org switch plus a cluster switch that can only add; a held request is a command in `PENDING_APPROVAL`.                                                                                                                                                                        |
| 041 | M7 started before M6's golden path 12 ran, on the owner's instruction; recorded as a deviation.                                                                                                                                                                                                 |
| 042 | Load-test fixes: fixed-query-count rewrites, shared caches, `DATABASE_POOL_MAX`, 250 ms SSE coalescing; a revoked grant can work up to 2 s. Targets reported as not met, then re-measured.                                                                                                      |
| 043 | Resilience by fault proxy; 503 with `Retry-After` on dependency loss; key re-wrap and CA rotation are operator CLIs, not REST endpoints.                                                                                                                                                        |
| 044 | Metrics declared in one file with bounded labels; allowlisted request log fields; an off-by-default tracing hook.                                                                                                                                                                               |
| 045 | Report answers are shared and single-flight for 30 s, keyed by what the caller may see.                                                                                                                                                                                                         |
| 046 | Cluster-scoped restore policy (G-4, default allow), per-stream message budget (G-10), enrol limits (G-11), production Redis needs a password (G-13).                                                                                                                                            |
| 047 | One control-plane image serving the SPA, a Helm chart (3 replicas, HPA 3 to 6, PDB, NetworkPolicy), air-gap scripts, expand-only migrations.                                                                                                                                                    |
| 048 | Retention job: a Redis lock, batches of 5 000, audit deletion only as `vfm_audit_retention`, optional CSV export before delete.                                                                                                                                                                 |
| 049 | Backup download is a signed link only, gated on the org setting, `backup:download` and sudo; the URL lives in Redis for the command id only.                                                                                                                                                    |
| 050 | An agent adopts a new bootstrap token after being disabled (found by golden path 11).                                                                                                                                                                                                           |
| 051 | A single-node kind cluster (`VFM_DEV_SOLO=1`) sidesteps the inotify limit; a development seed refuses to run in production.                                                                                                                                                                     |
| 052 | **SOW alignment**: keep the agent model for FR-03; add cluster metadata (FR-02), Velero compatibility (FR-20), a browser-side restore risk list (FR-10), PDF reports (FR-15), a secret-free config export (FR-19), SOW role display names over unchanged enum values. ClamAV (FR-18) not built. |
| 053 | **LDAP** sign-in for existing users (reverses the plan's "LDAP in v1.1"): search by email, bind as the match; no provisioning and no group mapping.                                                                                                                                             |

Defaults taken for the plan's open questions: self-hosted only (Q1); 200 clusters in year one (Q2); assume HTTP/2 and respect `HTTPS_PROXY`, a WebSocket fallback is a later decision (Q3); oldest Velero is primary minus two (Q4); browser download off by default, signed link only, Cluster Admin only (Q5); license and product name undecided, kept internal (Q6); 400-day audit retention with CSV export (Q7).

---

## 9. Open items and known gaps

**Needs the owner (no code can substitute)**

| #      | Item                                                                                                                                                                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1     | Raise the host inotify limits (`sudo sysctl -w fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288`, persisted in `/etc/sysctl.d/99-kind.conf`). Without it two kind clusters never finish building, so the two-cluster smoke test, golden paths on two clusters and the real agent's footprint cannot run. `VFM_DEV_SOLO=1` avoids it. |
| A2     | Restore drill on a real, non-kind cluster (§6.8).                                                                                                                                                                                                                                                                                                        |
| A3     | Install the agent on one real cluster and confirm it connects.                                                                                                                                                                                                                                                                                           |
| A4     | Make the five CI jobs required checks in branch protection.                                                                                                                                                                                                                                                                                              |
| **A5** | **Admin MFA is switched off locally** (`DEV_DISABLE_MFA`, set only by an untracked `docker-compose.override.yml`). **Re-enable before the final setup**: delete the override, and decide whether to keep or remove the flag.                                                                                                                             |

**Decisions with a default in place** (change if you disagree): cluster-scoped restores allowed unless the agent owner forbids it (ADR-046); a user with `storage:write` may point a location at a private address, mitigated by sudo and NetworkPolicy; ingest shares the connection pool with users, so two replicas is the documented minimum; minimum replicas 2 supported, 3 by default; oldest supported Velero v1.16.2; image registry `ghcr.io/shubhambatra/vfm-*`; image signing with cosign not done; reports may be 30 s stale; Redis TLS only warned about, not enforced; audit deletion by the application's own login (stricter option in §6.7); license and product name.

**Not built, by design or for lack of a decision**: ClamAV hook (FR-18); restore into another registered cluster (FR-09); CRD and storage-class preflight (FR-10); configuration import (FR-19); a cluster-list column and filter for the new metadata (FR-02); CA rotation with a second CA delivered in `HelloAck` beyond the bundle mechanism; envtest (Velero CRDs in a local API server; golden paths on kind are the substitute); Playwright (the UI is covered by unit and integration tests and the API-driven golden paths; Playwright adds a browser download to CI); agent footprint on a 5 000-pod cluster (measured only on a near-empty kind cluster: about 46 MiB RSS, 0.21 CPU-seconds in total, 217 goroutines at idle); scale of 50 000 Velero objects and 20 000 pods per cluster; the oldest-Velero e2e run; importing the Grafana dashboard into a real Grafana; invitations by email need an SMTP server (without one the link is shown in the UI).

---

## 10. Legacy Velero UI

`apps/` and `libs/` hold the original `otwld/velero-ui` application (Vue 3, reads clusters directly through a kubeconfig, no database). It is unrelated to VFM and keeps building. Its documentation site is `docs/` (Docusaurus), its Helm chart is `kubernetes/chart/`, and it has its own `libs/*/README.md`; those files are untouched.

Run it (port **3333**):

```bash
docker compose -f docker-compose.legacy.yml up -d
# with a local override:  docker compose -f docker-compose.legacy.yml -f docker-compose.legacy.override.yml up -d
```

The default `docker compose up -d --build` at the repository root runs the Fleet Manager, not this application.

---

## 11. Appendix: where the plan's sections went

Code comments cite sections of the original build plan (`PLAN.md`, now removed; it remains in git history). This table says where each topic lives now.

| Plan section                            | Now                                             |
| --------------------------------------- | ----------------------------------------------- |
| §0 Rules for building                   | §5.3 quality gates; §8 (record every deviation) |
| §1 Product summary, principles P1 to P6 | §1                                              |
| §2 Scope                                | §1 scope                                        |
| §3 Architecture, request flow, HA       | §3.1, §3.3                                      |
| §4 Tech stack                           | §3.1, §5.5, §5.6, ADR-001, ADR-006, ADR-007     |
| §4.4 Velero compatibility               | §3.10, ADR-002                                  |
| §5 Agent protocol (5.1 to 5.7)          | §3.2, §3.3, §3.4                                |
| §6 Velero CLI coverage                  | §3.10                                           |
| §7 Cluster status and logs              | §3.4, §3.5                                      |
| §8 Identity, orgs, RBAC                 | §3.6, §3.7, §3.8                                |
| §9 Data model                           | §3.9                                            |
| §10 REST API                            | §3.11, `docs/API.md`                            |
| §11 Web UI                              | §4                                              |
| §12 Security requirements               | §7, §5.5 (agent RBAC)                           |
| §13 Non-functional requirements         | §6.11, §6.12                                    |
| §14 Repository layout, dev environment  | §5.1, §5.2                                      |
| §15 Testing strategy                    | §5.3                                            |
| §16 Milestones and day-by-day plan      | Not kept: it was a schedule, now history        |
| §17 Production-readiness checklist      | §6.13                                           |
| §18 Open questions                      | §8 (defaults), §9                               |

Other removed files that code comments still name:

| Old file                                                                               | Now                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `docs/DECISIONS.md` (`ADR-nnn`)                                                        | §8                                               |
| `docs/THREAT_MODEL.md` (`G-n`, `A-n`, `M-n`, `C7-T`, `F-n`)                            | §7                                               |
| `docs/OPERATIONS.md`, `docs/AIRGAP.md`, `docs/RESILIENCE.md`                           | §6                                               |
| `docs/OBSERVABILITY.md`, `docs/LOADTEST.md`, `docs/RELEASE_CHECKLIST.md`               | §6.11, §6.12, §6.13                              |
| `docs/USER_GUIDE.md`                                                                   | §4                                               |
| `docs/PROGRESS.md`, `DEVELOPMENT_STATUS.md`, `NEXT_STEPS.md`, `DECISIONS_FOR_OWNER.md` | Session logs, not kept; what still matters is §9 |
| `server/README.md`, `agent/README.md`, `proto/README.md`, `loadtest/README.md`         | §5                                               |

`R-nnn` ids in comments referred to rows of the old requirement inventory (`DEVELOPMENT_STATUS.md`), which is not kept; the git history has it.
