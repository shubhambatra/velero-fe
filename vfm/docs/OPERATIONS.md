# Operations guide

How to install, run, upgrade, back up, rotate keys in and troubleshoot the Velero Fleet Manager (VFM) control plane and
its agents. Everything here is for the person running the installation. What the product does is in `USER_GUIDE.md`.

> **Verification status.** Commands and manifests in this guide were rendered and tested (chart tests, `helm lint`,
> unit and end-to-end suites, a built-image smoke test). **No step was run against a production Kubernetes cluster**:
> the dev machine could not build the two kind clusters (blocker B-2). Your first install is the first real one; the
> restore drill in section 9 is how you confirm it.

## 1. What you are running

```
 browsers ──HTTPS──▶ ingress ──▶ control plane (2+ replicas) ◀──mTLS gRPC── agents (one per cluster, dial OUT)
                                      │      │
                                      ▼      ▼
                                 PostgreSQL  Redis (password required in production)
```

- **Control plane**: one image (`vfm-control-plane`) carrying the REST API, the web UI, and the agent gateway (gRPC, port 8443).
  Stateless; all state is in PostgreSQL and Redis.
- **Agent**: one Helm release (`vfm-agent`) per managed cluster. It dials the control plane; the control plane never connects
  into a cluster and holds no cluster credentials.
- **Backup data never passes through VFM.** Velero in each cluster writes to its own object storage.

You bring: Kubernetes 1.27+, PostgreSQL 15+, Redis/Valkey 7+ with a password, and DNS names for the UI and for the agents.

## 2. Install the control plane

### 2.1 Secrets

```bash
kubectl create namespace vfm-system
kubectl -n vfm-system create secret generic vfm-control-plane \
  --from-literal=database-url='postgresql://vfm:CHANGE_ME@postgres.example:5432/vfm?sslmode=require' \
  --from-literal=redis-url='rediss://:CHANGE_ME@redis.example:6380' \
  --from-literal=master-key="$(openssl rand -base64 32)"
```

- **Back the master key up somewhere that is not the cluster.** It encrypts every stored secret (OIDC client secrets, MFA
  secrets, notification channel secrets, the internal CA key). Lose it and those are unreadable.
- The server **refuses to start in production if the Redis URL has no password** (threat model G-13). Use `rediss://` when
  Redis offers TLS; with plain `redis://` it starts and logs a warning.

### 2.2 Values

```yaml
# my-values.yaml
secrets:
  existingSecret: vfm-control-plane
gateway:
  publicAddress: agents.vfm.example.com:8443 # what agents dial
  hostnames: agents.vfm.example.com # goes into the gateway certificate
  service: { type: LoadBalancer }
config:
  publicUrl: https://vfm.example.com
  apiPublicUrl: https://vfm.example.com
ingress:
  enabled: true
  className: nginx
  host: vfm.example.com
  tls: { secretName: vfm-example-com-tls }
```

```bash
helm upgrade --install vfm deploy/helm/vfm-control-plane -n vfm-system -f my-values.yaml
```

Two things must be right, and the chart cannot check them for you:

1. **The agent gateway is passed through, not terminated.** It asks every agent for a client certificate signed by the internal CA.
   A proxy that terminates TLS strips it and no agent connects. Use a `LoadBalancer` Service, ingress-nginx
   `ssl-passthrough`, or a Gateway API `TLSRoute` in passthrough mode. Ready-made files: `deploy/helm/vfm-control-plane/examples/`.
2. **Postgres connections**: `replicas x config.databasePoolMax` (plus the migration job) must stay under the database's
   `max_connections` (100 by default). The default is 15 per replica, so the 3-replica floor uses 45 and the autoscaler's maximum of 6 uses 90 (plus the
   migration job): raise `max_connections` before raising either number. A pool larger than the database allows shows up as HTTP 500s ("too many clients").

### 2.3 First start

The migration Job runs before the pods start. Then:

```bash
kubectl -n vfm-system logs deploy/vfm-control-plane | grep -i "setup token"
```

The first start writes a **one-time setup token** to the log, in a boxed warning (it is the only secret the product ever
logs, and only while no user exists; a restart issues a fresh one if it expired). Use it on the UI's setup page, or with the
`curl` command the banner prints, to create the first platform administrator (12+ character password; MFA is required for
administrators). Setup closes permanently once a user exists.

### 2.4 Sizing

Measured on one host with a simulator (`docs/LOADTEST.md`): **4 replicas** met every target for 200 clusters and 100
concurrent users; **2 met them in one run of three**. The chart defaults to 3 (not itself measured) and scales to 6 on CPU.
Add replicas before adding CPU per replica. The three reports are the
heaviest requests and are shared between users for 30 seconds. The real agent's footprint and clusters of 50 000 Velero
objects / 20 000 pods were **not** measured.

## 3. Configuration reference

The chart sets these; set them directly if you deploy without the chart. Anything secret comes from a Secret, never a file.

| Variable                                                                           | Default             | Meaning                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` (secret)                                                            | required            | PostgreSQL connection string                                                                                                                                                                                                           |
| `REDIS_URL` (secret)                                                               | required            | Redis/Valkey; a password is required when `NODE_ENV=production`                                                                                                                                                                        |
| `VFM_MASTER_KEY` (secret)                                                          | required            | 32 random bytes, base64                                                                                                                                                                                                                |
| `VFM_MASTER_KEY_PREVIOUS`                                                          | -                   | comma-separated retired keys, kept while rotating                                                                                                                                                                                      |
| `PUBLIC_URL`, `API_PUBLIC_URL`                                                     | localhost           | where users reach the UI / the API (links in email, the OIDC redirect URI)                                                                                                                                                             |
| `PORT`, `METRICS_PORT`, `HOST`                                                     | 3000, 9090, 0.0.0.0 | listeners. Metrics are never on the public Service                                                                                                                                                                                     |
| `GATEWAY_ENABLED`, `GATEWAY_PORT`                                                  | true, 8443          | the agent gateway                                                                                                                                                                                                                      |
| `GATEWAY_PUBLIC_ADDRESS`, `GATEWAY_HOSTNAMES`                                      | localhost           | what agents dial, and the names in the gateway certificate                                                                                                                                                                             |
| `TRUST_PROXY`                                                                      | false               | how many proxies sit in front (a number, `true`, or a subnet); required for correct per-address rate limits                                                                                                                            |
| `DATABASE_POOL_MAX`                                                                | 30                  | connections per replica                                                                                                                                                                                                                |
| `AGENT_MESSAGES_PER_SECOND`, `AGENT_MESSAGE_BURST`                                 | 100, 1000           | per agent stream; over it the stream is closed and the agent reconnects (G-10)                                                                                                                                                         |
| `GATEWAY_ENROLL_PER_MINUTE`, `GATEWAY_ENROLL_MAX_INFLIGHT`                         | 30, 16              | `Enroll` limits per source address and per replica (G-11); raise the first for a large first rollout behind one NAT                                                                                                                    |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | unset               | email (invitations, lockout and approval notices). Unset: invitations are refused with 503                                                                                                                                             |
| `ALERT_EVAL_INTERVAL_SECONDS`                                                      | 30                  | alert evaluation; 0 turns it off                                                                                                                                                                                                       |
| `ALERT_WEBHOOK_ALLOW_PRIVATE`, `OIDC_ALLOW_PRIVATE`                                | false               | allow private-network webhook / identity-provider addresses (on-prem receivers)                                                                                                                                                        |
| `DOWNLOAD_CACHE_TTL_DAYS`                                                          | 7                   | how long fetched backup logs/results are cached                                                                                                                                                                                        |
| `LOG_SESSIONS_PER_USER`, `RESTORE_APPROVAL_TTL_HOURS`                              | see schema          | live-log and approval limits                                                                                                                                                                                                           |
| `OTEL_ENABLED`                                                                     | false               | tracing hook; needs `@opentelemetry/sdk-node` installed in the image                                                                                                                                                                   |
| `RETENTION_INTERVAL_HOURS`, `RETENTION_AUDIT`                                      | 24, true            | the daily purge of events (1 h), finished commands (180 d), expired cached files and soft-deleted objects; audit events by each organization's own setting (default 400 d). One replica runs it per interval; `0` turns it off (§ 10a) |
| `AUDIT_EXPORT_DIR`                                                                 | unset               | where audit events are written (CSV) before deletion, for organizations that turn on export-before-delete. Unset: those organizations' events are not deleted                                                                          |
| `WEB_DIST_DIR`                                                                     | set in the image    | directory of the built UI; unset serves the API only                                                                                                                                                                                   |

The authoritative list is `server/src/config/env.schema.ts`; a bad value stops the process at start with the variable's name
(never its value).

## 4. Identity

- **Local accounts**: argon2id, breached-password check, TOTP MFA with recovery codes, brute-force lockout.
- **OIDC per organization**: _Organization settings -> Single sign-on_: issuer, client id/secret, the group claim, and a
  mapping from groups to teams. Register `<API_PUBLIC_URL>/api/v1/auth/oidc/callback` with your identity provider. Users are
  created on first sign-in (JIT) and their team membership follows the claim.
- **Roles**: see `RBAC.md`. Organization Owners/Admins administer everything in their organization.

## 5. Install an agent

In the UI: _Clusters -> Add cluster_. It creates the cluster record and prints the exact command (a Helm install carrying the
control plane's CA bundle and a **single-use bootstrap token that expires in 24 hours**). Run it against the target cluster.

```bash
helm install vfm-agent oci://ghcr.io/shubhambatra/charts/vfm-agent -n vfm-system --create-namespace \
  --set controlPlane.address=agents.vfm.example.com:8443 \
  --set-file controlPlane.caBundle=ca.pem --set enrollment.token=...
```

The cluster page shows **Connected** within seconds, with the Velero and Kubernetes versions and plugins.

- **Policy** is the cluster owner's, set in the chart values (`policy.readOnly`, `restoreDeniedNamespaces`, `allowBslWrite`,
  `allowLogStreaming`...). The control plane cannot change it and the UI explains actions it disables.
- **Behind an HTTP proxy**: set `proxy.httpsProxy`/`noProxy`. The agent needs HTTP/2 and a long-lived stream; a proxy that
  cannot carry one is a known open question (plan section 18, Q3).
- **Upgrades**: the cluster page shows "update available" when the agent's chart is older than the control plane's.

## 6. Upgrades

```bash
helm upgrade vfm deploy/helm/vfm-control-plane -n vfm-system -f my-values.yaml --set image.tag=NEW
```

1. A **pre-upgrade Job** runs `prisma migrate deploy` and must succeed before any pod changes.
2. The Deployment rolls with `maxUnavailable: 0`: new pods become ready before old ones leave. Agents reconnect to whichever
   replica answers; commands in flight are redelivered and the agent does not run one twice.
3. **Migrations are expand-first**: a release only adds (columns, tables, nullable fields), so the previous release keeps
   working against the new schema during the roll. Removing something takes a second release, after the first is everywhere.
   The migration test (`server/src/prisma/migrations.test.ts`) fails a migration that drops or renames a column or table
   without an explicit, reviewed exemption.
4. **Roll back** by `helm rollback`. Because the schema only grew, the old release still runs. Restore the database backup only
   if a migration itself went wrong.

Always take a database backup (section 7) before an upgrade.

## 7. Backing up VFM itself

What to protect, in order of importance: **the PostgreSQL database**, **the master key**, and your Helm values. Redis holds
sessions and counters only; losing it signs everyone out and nothing more.

- **Logical dump** (works anywhere, run it on a schedule you can restore from):

  ```bash
  pg_dump --format=custom --file=vfm-$(date +%F).dump "$DATABASE_URL"
  # restore:  pg_restore --clean --if-exists --dbname="$DATABASE_URL" vfm-YYYY-MM-DD.dump
  ```

- **With Velero** (VFM backing itself up, which is the point). If PostgreSQL runs in the cluster, quiesce it with a hook and
  schedule the namespace. This is an example, adapt the labels and container to your database:

  ```yaml
  apiVersion: velero.io/v1
  kind: Schedule
  metadata: { name: vfm-nightly, namespace: velero }
  spec:
    schedule: '30 1 * * *'
    template:
      includedNamespaces: [vfm-system]
      defaultVolumesToFsBackup: true
      ttl: 720h
      hooks:
        resources:
          - name: pg-dump
            includedNamespaces: [vfm-system]
            labelSelector: { matchLabels: { app.kubernetes.io/name: postgresql } }
            pre:
              - exec:
                  container: postgresql
                  command:
                    [
                      '/bin/sh',
                      '-c',
                      'pg_dump -Fc -U vfm vfm > /bitnami/postgresql/vfm-prehook.dump',
                    ]
                  onError: Fail
                  timeout: 5m
  ```

  A managed/external database is backed up by its provider; the dump above still works.

- **Restore order**: database, then the master key Secret, then `helm upgrade --install`. The audit log is append-only in the
  database and is included.
- **Practise it.** An untested backup is a hope. Restore into a scratch namespace before you need to.

## 8. Rotation

### 8.1 `VFM_MASTER_KEY`

1. Generate a new key; set it as `VFM_MASTER_KEY`, and move the old one to `VFM_MASTER_KEY_PREVIOUS`. Roll the replicas. Everything still opens.
2. `node dist/rewrap.js --dry-run` shows how many values are still on an old key (per column).
3. `node dist/rewrap.js` re-encrypts them under the new key. Safe while the server is up; run it again to be sure.
4. When it reports `stale: 0` everywhere, remove the old key from `VFM_MASTER_KEY_PREVIOUS` and roll again.
5. Keep the old key until a database backup taken before step 3 has aged out.

Run the commands in a pod of the release: `kubectl -n vfm-system exec deploy/vfm-control-plane -- node dist/rewrap.js --dry-run`.

### 8.2 The internal CA

Agents receive a PEM bundle at enrolment and with each renewal (every 7 days at most), so a second CA needs no re-enrolment.

1. `node dist/ca-rotate.js stage`: a new CA joins the bundle (nothing signs with it yet; `unstage` undoes it).
2. Wait one agent-certificate lifetime (7 days).
3. `node dist/ca-rotate.js promote`: the new CA signs from now on; the old one is retiring but still trusted.
4. Wait another lifetime.
5. `node dist/ca-rotate.js retire`: the old CA is deleted.

`status` prints each CA's state. `promote`/`retire` refuse before the wait is over (`--force` is logged). An agent offline for
longer than a certificate lifetime must be re-enrolled whatever you do. These commands run outside the API and are **not**
in the audit log: record their output with your change ticket.

### 8.3 An agent's credentials

On the _Clusters_ page, **Rotate certificate…**, **Disable…** and **Delete…** revoke its certificate: its open stream is closed within a minute at the
latest (immediately in the normal case), and it cannot reconnect. Re-enrol with a new bootstrap token.

## 9. Restore drill (do this once, on a real cluster)

The product has never restored on a real non-kind cluster. Before you rely on it:

1. Install an agent on a non-production cluster that has Velero and real object storage.
2. Back up a namespace that has a PVC with known data (`sha256sum` it first). Wait for `Completed`; read the backup's logs in the UI.
3. Delete the namespace. Restore it from the UI (typed confirmation + sudo).
4. Check the pods run and the checksum matches. Repeat with _namespace mapping_ (`demo -> demo-restored`).
5. Note anything that differed from this guide in `docs/PROGRESS.md`.

## 10. Observability

- `/metrics` on port 9090 (separate listener, own Service, never the ingress). Metric list: `OBSERVABILITY.md`.
- Dashboard (`deploy/observability/vfm-control-plane.dashboard.json`) and alert rules (`vfm-alerts.rules.yaml`): set
  `metrics.dashboard.enabled` / `metrics.prometheusRule.enabled` / `metrics.serviceMonitor.enabled` in the chart. **They have
  not been imported into a real Grafana or Prometheus**; run `promtool check rules` on first use.
- Logs are JSON, one object per line, with an allowlist of fields (`OBSERVABILITY.md`). Secrets and query strings are never logged.
- Health: `/healthz` (process only) and `/readyz` (PostgreSQL and Redis; 503 if either is down).

## 10a. Retention, backup downloads, the dev seed and the dev cluster

**Retention (R-101).** Events older than an hour, finished commands older than 180 days, expired cached log files and
objects deleted in the cluster more than 7 days ago (backups: 400 days, so the 366-day reports still count them) are removed
daily. Audit events follow each organization's _Settings → Security_ values (retention days, export before delete). The
audit table is append-only: only the Postgres role `vfm_audit_retention` can delete from it. By default the application's login is
a member, so the in-process job purges. To make the running application unable to erase its own trail, set
`retention.audit=false` in the chart and run `node dist/retention.js` on a schedule (a CronJob) with a separate login that is a member.
Without membership, nothing is deleted. To run it once by hand: `pnpm --filter @vfm/server run retention`.

**Backup download (R-055).** Off by default. An organization Owner turns on _allow backup content download_; only a role that
holds `backup:download` over every namespace of the backup (Cluster Admin) can then ask, with sudo. The agent asks Velero for a
signed link to the object store and the control plane hands that one link to that one request (`Cache-Control: no-store`). It is
never stored, logged or audited (only that a link was issued), and the backup data never passes through VFM. The link lasts about nine minutes (the agent asks for 9; the control plane refuses a link that lives longer than 30).
A cluster where the agent's `readOnly` policy is on refuses it.

**Cluster-scoped restores (G-4).** The agent chart value `policy.allowClusterScopedRestore` (default `true`). Set it `false` and
every restore must carry `includeClusterResources: false`; Velero treats an unset value as true, so the agent refuses restores that leave it unset.

**Seed (R-131), development only.** `pnpm --filter @vfm/server run build && pnpm --filter @vfm/server run seed` creates a platform
administrator, two organizations (`acme`, `globex`), a user per built-in role (`owner@acme.dev`, `viewer@acme.dev`, …, one limited to
the `demo` namespace) and one cluster per organization with a bootstrap token. All accounts share `SEED_PASSWORD`. It refuses to run
when `NODE_ENV=production`, and a second run changes nothing.

**Real-Velero development stack.** `vfm/e2e/stack.sh up` starts Postgres, Redis and the control plane as containers on the kind network;
`VFM_DEV_SOLO=1 make dev-up` builds one single-node kind cluster with Velero v1.18.4 and MinIO (no inotify change needed);
`vfm/e2e/load-agent.sh` builds the agent image under a unique tag and installs it (an image tag reused in kind is not re-pulled);
`node vfm/e2e/sim-clusters.mjs` enrols four SIMULATED clusters (`sim-*`, with labels) beside the real one so the multi-cluster UI has a fleet
to show (run the printed `loadtest` command to bring them online; they have generated data and no Velero behind them). A second REAL kind cluster
(`VFM_DEV_SOLO=1 VFM_DEV_SOLO_B=1 deploy/dev/scripts/dev-up.sh --cluster vfm-b`) needs more inotify instances than the default 128 when other kind clusters exist.
`node vfm/e2e/golden.mjs [--only gp5]` runs the golden paths against all of it, after `vfm/e2e/reset-workloads.sh`.

## 11. Troubleshooting

**An agent will not connect**

| Symptom (agent log)                                                   | Cause                                                                           | Fix                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `x509: certificate signed by unknown authority`                       | wrong or missing `controlPlane.caBundle`; or a TLS-intercepting proxy           | use the CA from _Add cluster_; the agent trusts only that CA, so exclude the gateway from interception |
| `transport: authentication handshake failed` / `tls: bad certificate` | a proxy or L7 balancer terminates TLS in front of the gateway                   | pass TLS through (section 2.2)                                                                         |
| `connection refused` / timeout                                        | the gateway Service is not reachable from the cluster; egress blocked           | open egress to `host:8443`; check `NetworkPolicy` `gatewayFrom`                                        |
| `Unauthenticated: ... token`                                          | bootstrap token used, expired (24 h) or for another cluster                     | _Add cluster_ again to get a new command                                                               |
| `ResourceExhausted` on enrol                                          | `GATEWAY_ENROLL_PER_MINUTE` reached for that source address                     | wait a minute or raise the limit; the agent retries by itself                                          |
| connects, then closed with `message rate limit exceeded`              | the agent exceeded `AGENT_MESSAGES_PER_SECOND`                                  | not expected for a healthy agent: investigate the agent; raise the limit only if it is legitimate      |
| `Unauthenticated` after working                                       | certificate revoked (cluster disabled/rotated/deleted) or expired while offline | re-enrol                                                                                               |
| `FailedPrecondition: fingerprint`                                     | the credentials are now running in a different cluster                          | the agent was copied; enrol the new cluster separately                                                 |
| `HTTP/2` or stream errors through a proxy                             | the proxy cannot carry long-lived HTTP/2                                        | use a TCP/TLS passthrough path; see plan section 18 Q3                                                 |

The cluster page shows the last heartbeat. An agent silent for 45 seconds is marked Disconnected.

**The UI**

- _Everything is 503_: PostgreSQL or Redis is unreachable. `/readyz` says which; sessions live in Redis so nobody can sign in while it is down.
- _HTTP 500 "too many clients"_: pool sizing, section 2.2.
- _Cannot sign in with SSO_: the redirect URI must be exactly `<API_PUBLIC_URL>/api/v1/auth/oidc/callback`; for a private
  identity provider set `OIDC_ALLOW_PRIVATE=true`.
- _Invitations do not arrive / 503 on invite_: `SMTP_HOST` is unset or unreachable.
- _A report looks old_: reports are shared for 30 seconds by design.

**Commands**

- _Stuck in SENT_: the agent is disconnected; it is redelivered on reconnect, or becomes `TIMED_OUT` once its deadline passes (each operation has its own, in `server/src/commands/ops.ts`).
- _Disabled button_: hover it: the UI states the reason (permission, agent policy, or a missing Velero capability).
- _Backup command succeeded but the backup failed_: these are different things by design; the backup's own phase and logs say why.

## 12. Network and security checklist

- Postgres and Redis reachable only from the control plane's namespace (NetworkPolicy; the chart's egress rules are optional).
- Redis has a password (enforced) and ideally TLS.
- Metrics port not exposed. The chart gives it its own Service.
- `TRUST_PROXY` set to the real number of proxies in front, or per-address limits see only the proxy.
- The gateway Service is the only thing agents need; narrow `loadBalancerSourceRanges` to your clusters if you can.
- Make the CI jobs required checks on the repository (R-114).
- Read `THREAT_MODEL.md`, especially the accepted risks (section 7).
