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
| B1 | **G-4**: should a restore of cluster-scoped resources (CRDs, ClusterRoleBindings, PVs) be allowed unless the owner forbids it? | _see below once built_ | small | |
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

_(appended during the work below)_
