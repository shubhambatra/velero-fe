# Next steps

**Updated:** 2026-10-16 (end of session 5) · **Branch:** `vfm/m0-foundation`

For a new session or a new agent: this file is the continuation point.
[`DEVELOPMENT_STATUS.md`](./DEVELOPMENT_STATUS.md) holds the requirement
inventory and progress. [`VELERO_FLEET_PLAN.md`](./VELERO_FLEET_PLAN.md) is the
only source of requirements — these two files are recovery aids, nothing more.

---

## Start-of-session procedure

1. Read `VELERO_FLEET_PLAN.md` §0 and §16, then re-read the sections named by
   the task below. For anything you are about to implement, read the original
   section rather than its summary here.
2. Read `DEVELOPMENT_STATUS.md` sections 2, 4, 7 and 10.
3. Inspect git: `git status`, `git log --oneline -10`, `git branch -vv`,
   `git fetch && git status -sb` to confirm the remote state.
4. Reconcile the recorded state against reality:
   ```bash
   cd vfm
   make doctor          # which prerequisites exist
   make lint && make test
   ```
   If a result contradicts `DEVELOPMENT_STATUS.md`, **trust the repository** and
   correct the status file before doing anything else.
5. Resume from "The next task" below.

---

## Two blockers to clear first — both need root, neither could be done from the session

### B-2 — raise the host inotify limits (one command, do this first)

Two two-node kind clusters exceed this machine's inotify budget
(`max_user_instances` is 128, 512 is needed). Below it, `kube-proxy` on a worker
crash-loops with "too many open files", nothing on that node reaches a Service
IP, and the failure shows up minutes later as an unrelated rollout timeout.
`dev-up.sh` now refuses to start until this is fixed.

```bash
sudo sysctl -w fs.inotify.max_user_instances=512
sudo sysctl -w fs.inotify.max_user_watches=524288
# persist across reboots
echo -e 'fs.inotify.max_user_instances=512\nfs.inotify.max_user_watches=524288' \
  | sudo tee /etc/sysctl.d/99-kind.conf && sudo sysctl --system
```

Then, from `vfm/deploy/dev`:

```bash
./scripts/dev-up.sh     # ~5-10 min: builds vfm-a and vfm-b with Velero
./scripts/smoke.sh      # must report Completed on BOTH clusters
```

`smoke.sh` passing is the M0 exit criterion. It has never run.

### B-1 — install the Go toolchain

**Go, `make`, `buf` and `golangci-lint` are not installed.** The owner elected to
install them. The agent's ~2 900 lines of Go exist but have **never been
compiled or tested** — treat them as unverified until this is done.

```bash
curl -LO https://go.dev/dl/go1.27.2.linux-amd64.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.27.2.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin:$HOME/go/bin' >> ~/.bashrc
sudo apt-get install -y make
sudo curl -sSL https://github.com/bufbuild/buf/releases/download/v1.73.0/buf-Linux-x86_64 \
  -o /usr/local/bin/buf && sudo chmod +x /usr/local/bin/buf
go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest
```

Then verify the agent, which is the first thing to do in the next session:

```bash
cd vfm/agent
go mod tidy          # go.sum does not exist yet and must be generated here
go build ./... && go test ./... && golangci-lint run ./...
```

Expect `go mod tidy` to adjust module versions — they were written by hand
against the module proxy without a compiler available. Record any version
change in `vfm/docs/DECISIONS.md`.

---

## The next task

### 1. Close out M0 (finish before starting M1)

| # | Task | Acceptance criteria | Verify with |
|---|---|---|---|
| 1 | Clear B-2, then build both clusters and pass the smoke test (R-129, R-130) | `velero backup create` reaches phase `Completed` on `vfm-a` **and** `vfm-b` | `./scripts/dev-up.sh && ./scripts/smoke.sh` in `vfm/deploy/dev` |
| 2 | Clear B-1, then verify the agent (R-021, R-132) | `go build` and `go vet` clean, unit tests pass, `golangci-lint` clean, `go.sum` committed | `cd vfm/agent && go mod tidy && go build ./... && go test ./... && golangci-lint run ./...` |
| 3 | ~~Confirm CI is green~~ — **done**: green on `ee17789`. The Go jobs begin running once `go.sum` is committed in task 2 | all jobs pass | `gh run list --workflow 'VFM CI'` |
| 4 | Re-run `dev-up` twice to prove idempotency end to end (R-130) | the second run changes nothing and reports what it skipped; `kind-velero` untouched | `./scripts/dev-up.sh` twice |

**Only when all four pass is M0 complete.** Record it in `vfm/docs/PROGRESS.md`
and move R-021, R-129, R-130 and R-132 to ✅ in `DEVELOPMENT_STATUS.md`.

Already done, do not redo: migrations are applied to both `vfm` and `vfm_test`
(re-run `prisma migrate deploy` against `vfm_test` after pulling a new
migration — the e2e suite fails with "table does not exist" otherwise);
`openapi.yaml` is committed and in sync; 313 unit tests plus 81 e2e tests, lint,
format, typecheck and build are green; M1 days 4, 5 and 6 are complete and
verified.

### 2. ~~M1 days 4, 5 and 6~~ — **done**

Day 4 `1f0162d`, day 5 `5a8bc63`, day 6 `b124e5b`. Details in
`vfm/docs/PROGRESS.md`; design in ADR-008, ADR-009 and ADR-010. Do not redo them.

### 3. ~~M1 day 7 — OIDC~~ — **done** in session 5 (`f6fe5f8`)

R-090 verified against Dex; design in ADR-011. Do not redo it. Dex is on
`:55556`; the e2e suite now needs it running (`make dev-up`).

### 4. Then M1 day 8 — RBAC engine

`VELERO_FLEET_PLAN.md` §16 day 8 (line 652–655), implementing §8.2 (line
376–395) and §9 `role_bindings` (line 427).

- **Permission constants in `packages/shared`**, and the four built-in roles as
  **data** (a permission array), not code — §8.2 line 393.
- **`role_bindings`**: org-owned, `(user|team) → role → scope`, scope being
  `CLUSTER`, `NAMESPACES` (list) or `SELECTOR` (label selector). There is no
  `clusters` table yet (M2), so `cluster_id` is a plain UUID column for now —
  record that in an ADR and add the FK in M2.
- **`authorize(user, clusterId, permission, {namespaces?, includesClusterScoped?})`**
  plus a Nest guard.
- **Table-driven tests, 50+ cases**: team inheritance, org Owner/Admin implicit
  Cluster Admin, and the §8.2 namespace rule (line 395): every included
  namespace — after mapping, for restores — must be in scope, cluster-scoped
  resources are refused for scoped bindings, wildcard / empty "all namespaces"
  only for whole-cluster bindings. "The most security-critical function in the
  codebase."

**Acceptance criteria:** ≥ 50 table-driven cases pass including every scope
edge named above; a user with no binding is denied; a scoped Operator is denied
`kube-system` and "all namespaces" (golden path 7, as far as it can be proven
without agents); `pnpm run test` and `test:e2e` green, and the built server
exercised over HTTP.

**Things to get right:**
- **Deny by default, and deny on doubt.** An unparseable scope, an unknown
  permission or a missing cluster must deny, never fall through to allow.
- **Selector scopes need namespace labels**, which only arrive with inventory in
  M3. Until then a `SELECTOR` binding must evaluate to *deny* for a namespace
  whose labels are unknown, and say so in the test names.
- **Pure function first.** Keep `authorize` free of I/O (take the bindings as
  an argument) so the 50 cases run without a database; the guard loads bindings
  and calls it. Org scoping applies to the loader: `role_bindings` is org-owned.
- **Binding changes need sudo** (§8.3 line 405: "role binding changes").

### 5. Then day 9

Audit log (append-only DB role, interceptor on every mutating route — today's
org/invite/team/OIDC mutations are unaudited), API tokens, and the M1 UI; then
⛔ **HUMAN CHECKPOINT** (line 662).

---

## Context a new session needs

- **The repository hosts two unrelated applications.** `apps/` and `libs/` are
  the legacy `otwld/velero-ui` fork (Vue 3, kubeconfig-direct, no database).
  VFM is everything under `vfm/`. Do not import from or modify the legacy code;
  see `vfm/docs/DECISIONS.md` ADR-003 for why.
- **Run VFM commands as `make -C vfm <target>`.** The `vfm/` workspace uses pnpm
  10.20.0 via corepack; the repository root uses npm and Nx. Never run `pnpm
  install` at the repository root.
- **Dev ports are deliberately non-default** (Postgres 55432, Valkey 56379,
  MinIO 59000/59001, Mailpit 51025/58025, Dex 55556) because 5432 is already
  taken on this machine. See `vfm/deploy/dev/README.md`.
- **Do not touch the pre-existing kind cluster `kind-velero`.** VFM's clusters
  are `vfm-a` and `vfm-b`.
- **Velero pins:** primary v1.18.4, oldest supported v1.16.2, Go module path
  `github.com/vmware-tanzu/velero` (ADR-002). These live in three places that
  must change together: `packages/shared/src/velero-support.ts`, `Makefile`,
  ADR-002.
- **Before writing anything that touches a Velero object**, read the Go type
  from the pinned release. §0 rule 4 forbids inventing or inferring fields, and
  the legacy `libs/velero` TypeScript models are not authoritative.
- Commits so far bypassed the repository-root `.husky/pre-commit` hook, which
  runs `nx run-many --target=lint` over the legacy workspace. VFM lint,
  typecheck and tests were run explicitly instead.
- **The e2e suite needs a `vfm_test` database**, which already exists locally.
  On a fresh machine: `docker exec vfm-dev-postgres createdb -U vfm vfm_test`
  then `DATABASE_URL=...vfm_test pnpm --filter @vfm/server exec prisma migrate
  deploy`. Override targets with `TEST_DATABASE_URL` / `TEST_REDIS_URL`.
- **Org-scoped data needs a scope.** Any model with an `orgId` can only be
  queried inside `prisma.inOrg(orgId, …)` (or a reasoned `prisma.unscoped(…)`);
  otherwise it throws. A new table with an `orgId` is covered automatically; one
  without must be added to `NOT_ORG_OWNED` in `src/prisma/org-scope.ts` or its
  test fails. Every `/orgs/{orgId}/…` route starts with
  `OrgAccessService.require`. Details: ADR-010.
- **`pnpm run gen` builds first.** It compiles and runs `dist/openapi.js`
  because `tsx` emits no decorator metadata. It needs `DATABASE_URL`,
  `REDIS_URL` and `VFM_MASTER_KEY` set to anything well-formed.
- **Mail.** `SMTP_HOST` unset makes invitations return 503. Dev sink is Mailpit:
  `SMTP_HOST=localhost SMTP_PORT=51025`, UI on 58025. `server/.env` has it set.
- **Authentication is deny-by-default**, and now in three layers: `SessionGuard`
  (401 without a session, 403 while a second factor is outstanding), `CsrfGuard`
  (403 without a matching token on a state-changing call) and `SudoGuard` (403
  without recent re-authentication on a `@RequiresSudo()` route). All three are
  global, so a new controller is protected until it opts out with `@Public()`,
  `@AllowsMfaPending()` or neither. Forgetting it shows up as a 401/403, not as
  a missing guard — that is deliberate.
- **`VFM_MASTER_KEY` is required** and must be 32 bytes of base64. Generate one
  with `openssl rand -base64 32`. `server/.env` has a local value already;
  it is gitignored.
- **TOTP codes are single-use.** A test that spends the current time step must
  ask for the next one — `totp.generateForTesting(secret, 1)` — rather than
  calling again and getting the same six digits back.

---

## Unresolved decisions

None blocking. Four questions are open and are listed with their current
assumptions in `DEVELOPMENT_STATUS.md` section 8 — the two that cause rework if
answered differently are §18 Q4 (oldest Velero version in the field) and §18 Q6
(license and product name for the combined work).

---

## Before calling any increment done

A green test suite is **not** sufficient evidence that the service works. Four
defects in session 2 passed 140 unit tests and 27 e2e tests and surfaced only
when the built server was run: the test runner's SWC config uses set-semantics
class fields (hiding a Nest DI failure) and Vite resolves workspace packages
from source (hiding that `@vfm/shared` shipped raw TypeScript). Two more were
undeclared dependencies that resolved locally through pnpm's layout and were
absent on a clean install.

So for any increment that touches the control plane, also run:

```bash
cd vfm
pnpm run build                              # all three workspaces
pnpm --filter @vfm/server run test:e2e      # needs make dev-up
cd server && node dist/main.js              # the artifact that actually ships
```

and exercise the feature over HTTP against that process, not only through the
suite.

## End-of-session procedure

1. Update `vfm/docs/PROGRESS.md` with the session entry required by §0 rule 2.
2. Update `DEVELOPMENT_STATUS.md` — statuses, the progress count, commits and
   push status — from **actual** verification results, not intent.
3. Update this file with the next exact task and its acceptance criteria.
4. Commit the tracking updates as their own small commit.
5. Push, and verify with `git push` output and `git status -sb`. If pushing is
   unavailable, say plainly that the work exists only locally and is **not**
   backed up remotely.
