# Decisions and confirmations needed from the owner

One file, answered once. Each item says what I did in the meantime (the **default taken**), so work was never blocked,
and what it costs to change your mind. Answer by editing the **Your answer** line, or just tell me the numbers.

Legend: 🔴 blocks a release claim · 🟡 a default is in place, please confirm · ⚪ informational

## A. Things only you can do (no code can substitute)

| # | Item | Why it needs you | Status |
|---|------|------------------|--------|
| A1 | 🔴 **Raise the host inotify limits** (`sudo sysctl -w fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288`, persist in `/etc/sysctl.d/99-kind.conf`). | Needs root; this is blocker **B-2**. Without it the two kind clusters (`vfm-a`, `vfm-b`) never finish building, so `smoke.sh`, golden paths 1–12 against real Velero, and the real agent's footprint (R-120) cannot run. | Not done. Everything that does not need a real cluster is done and tested. |
| A2 | 🔴 **Restore drill on a real, non-kind cluster** (PLAN §17, last box; M4 checkpoint). | Needs a cluster and object storage that are yours. | Not done. Install steps are in `vfm/docs/OPERATIONS.md`. |
| A3 | 🔴 **Install the agent on one real cluster and confirm it connects** (M2 checkpoint). | Same. | Not done. |
| A4 | 🟡 **Make the five CI jobs required checks** in branch protection (R-114). | GitHub repository settings are yours. | Not done. |
| A5 | 🟡 **Push the branch.** Local commits are ahead of `origin/vfm/m0-foundation`. | I do not push without being asked. | Not pushed. |

## B. Product and security decisions (a default is in place)

| # | Question | Default taken | Cost of changing | Your answer |
|---|----------|---------------|------------------|-------------|
| B1 | **G-4**: should a restore of cluster-scoped resources (CRDs, ClusterRoleBindings, PVs) be allowed unless the owner forbids it? | Built: chart value `policy.allowClusterScopedRestore` defaults to **true** (allow), an agent with no policy at all denies (ADR-046). | small | |
| B2 | **A-3**: accept that a user with `storage:write` can point a storage location at a private-range address in the customer's network (needed for on-prem object storage)? Loopback and metadata addresses are already blocked. | Accepted, mitigated by sudo mode + NetworkPolicy. | none to accept; a deny-list setting if not | |
| B3 | **Ingest connection pool** (found in the load test): on one replica, ingest batches failed 220 times with "Unable to start a transaction in the given time" because users and ingest share the pool. Give ingest its own pool? | Left shared; two replicas are the documented minimum (`vfm/docs/LOADTEST.md`). | medium | |
| B4 | **Minimum replicas**: document 2 as the supported minimum for the §13 targets? | Yes (HPA min 2, PDB). | none | |
| B5 | **License and product name** for the combined work (the upstream is Apache-2.0) — §18 Q6. | Keep internal; the chart and docs say "Velero Fleet Manager". | rework of names in charts, docs, images | |
| B6 | **Oldest supported Velero** — §18 Q4. | primary − 2 minors (v1.16.2). | capability map, CI matrix | |
| B7 | **Image registry and names** (`ghcr.io/shubhambatra/vfm-*`). | As in the agent chart. | values only | |
| B8 | **Sign images with cosign** (PLAN day 44: optional). | Not done; the release workflow documents the command. | needs a key policy | |
| B9 | **Stale reports**: reports are shared answers up to 30 s old (ADR-045). Acceptable? | Yes. | one constant | |
| B10 | **Redis in production** must have a password (enforced at start-up) but TLS is only warned about (G-13). Enforce TLS too? | Warn only. | one line | |

## C. Open items recorded as they come up

| # | Item | Default taken / state | Your answer |
|---|------|-----------------------|-------------|
| C1 | 🟡 **R-126 deviation**: the plan names `tools/fake-agent`; the load simulator is `agent/cmd/loadtest` (reuses the real agent's gRPC client and proto). | Kept where it is; recorded as a deviation. Moving it is a rename. | |
| C2 | 🟡 **R-133 envtest** (Velero CRDs in a local API server): not built. Agent behaviour against real Velero is covered instead by golden paths on a real single-node kind cluster running Velero v1.18.4 (`vfm/e2e/golden.mjs`). Needs the `kube-apiserver`/`etcd` binaries downloaded at CI time. | Not built; kind e2e is the substitute. | |
| C3 | 🟡 **R-120 agent footprint on a 5 k-pod cluster**: measured only on a near-empty kind cluster (≈ 46 MiB RSS, 0.21 CPU-s total, 217 goroutines at idle). A 5 k-pod number needs a bigger cluster. | Reported as measured, not as met. | |
| C4 | 🟡 **R-118 scale** (50 k Velero objects, 20 k pods per cluster) was not exercised; 200 clusters and 100 users were. | Open. Needs a big host. | |
| C5 | 🟡 **R-137 Playwright**: no Playwright suite; UI is covered by 511 web unit/integration tests and the API-driven golden paths. | Open. Adding Playwright adds a ~300 MB browser download to CI. | |
| C6 | 🟡 **Second kind cluster (`vfm-b`)**: single-node `vfm-a` only (`VFM_DEV_SOLO=1`). The seed creates `vfm-b` in the database but nothing enrols it. | Fine for all golden paths; a two-cluster run is a hardware question. | |
| C7 | 🟡 **Oldest-supported Velero (v1.16.2) e2e matrix**: golden paths ran on v1.18.4 only. | Open. One more kind run with another chart value. | |
| C8 | ⚪ **Invitations by e-mail** need an SMTP server; without one the invite link is shown in the UI. | As built. | |
| C9 | ⚪ **Chart default `replicaCount: 3`** (HPA 3–6, pool 15 each) was chosen from the load test's four-replica run; three replicas specifically were not measured. | Documented. | |
| C10 | 🟡 **Audit retention role model (ADR-013)**: audit rows are deleted only as the Postgres role `vfm_audit_retention` (a trigger refuses every other UPDATE/DELETE). Default: the application's own login is a member, so the in-process daily job purges (`retention.audit: true`). Stricter: set `retention.audit: false` and run `node dist/retention.js` on a schedule with a separate login that is a member, so the running application can never erase its trail. If the login is not a member, nothing is deleted. Which do you want as the default? | Default: in-process. | |
| C11 | 🟡 **CA rotation with overlap (R-109)** is not built. | Open; no consumer yet. | |
| C12 | 🟡 **Grafana import (R-124)**: dashboard JSON is pinned by tests but was not loaded into a real Grafana. | Open. | |
| C13 | ⚪ A hook in this environment repeatedly claims "a PR was created"; none exists and none was created. Ignored. | — | |
