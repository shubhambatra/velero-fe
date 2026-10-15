# Next steps

**Updated:** 2026-10-15 08:45 IST (end of session 2) · **Branch:** `vfm/m0-foundation`

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

Already done, do not redo: the first migration is applied and `migrate status`
reports in sync; `openapi.yaml` is committed and verified in sync with the
decorators; 140 unit tests plus 27 e2e tests, lint, format, typecheck and build
are green; M1 day 4 is complete and verified.

### 2. ~~M1 day 4~~ — **done** in session 2 (`1f0162d`)

R-088, R-091, R-092, R-093 and R-112 are verified: 104 unit tests and a 27-test
e2e suite against real PostgreSQL and Redis. Details in
`vfm/docs/PROGRESS.md`. Do not redo it.

### 3. Then M1 day 5 — MFA and sudo mode

`VELERO_FLEET_PLAN.md` §16 day 5 (lines 643–644), implementing §8.3 (lines 399,
405) and §9 (`mfa_secret_encrypted`).

- TOTP enrol / verify / disable, with the shared secret in
  `users.mfa_secret_encrypted`.
- **10 recovery codes**, hashed, shown once.
- Org-enforced MFA — default required for Owner and Admin. Note this needs the
  `organizations.settings` shape, which exists in the schema already.
- Sudo re-auth endpoint plus a guard decorator, re-authentication valid for
  5 minutes (§8.3 line 405).

**Requirements covered:** R-089, R-095, and R-099 (envelope encryption — this
is the first `*_encrypted` column, so AES-256-GCM with a key id lands here).

**Acceptance criteria:** unit tests for TOTP window handling and replay
rejection, recovery-code single use, and the 5-minute sudo window including its
expiry; an e2e test proving a password-only session cannot pass a sudo-guarded
route. `pnpm run test` and `test:e2e` green.

**Two seams already in place for it:**
- `SessionRecord.mfaPending` is set by `login` when the user has MFA enabled,
  but `SessionGuard` does **not** yet refuse such a session. Day 5 must close
  that. It is currently unreachable because nothing can set `mfaEnabled`.
- `SessionRecord.lastReauthAt` is written on login and is what the sudo guard
  will read; `SessionService.update` already persists it.

**Dependency:** `VFM_MASTER_KEY` becomes **required** rather than optional in
`env.schema.ts`, because the TOTP secret is the first encrypted column. Generate
one with `openssl rand -base64 32`.

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
- **Authentication is deny-by-default.** `SessionGuard` and `CsrfGuard` are
  global, so any new controller is protected until it carries `@Public()`.
  Forgetting it on a probe or a webhook shows up as a 401, not as a missing
  guard — that is deliberate.

---

## Unresolved decisions

None blocking. Four questions are open and are listed with their current
assumptions in `DEVELOPMENT_STATUS.md` section 8 — the two that cause rework if
answered differently are §18 Q4 (oldest Velero version in the field) and §18 Q6
(license and product name for the combined work).

---

## End-of-session procedure

1. Update `vfm/docs/PROGRESS.md` with the session entry required by §0 rule 2.
2. Update `DEVELOPMENT_STATUS.md` — statuses, the progress count, commits and
   push status — from **actual** verification results, not intent.
3. Update this file with the next exact task and its acceptance criteria.
4. Commit the tracking updates as their own small commit.
5. Push, and verify with `git push` output and `git status -sb`. If pushing is
   unavailable, say plainly that the work exists only locally and is **not**
   backed up remotely.
