# Next steps

**Updated:** 2026-10-15 00:30 IST (end of session 1) · **Branch:** `vfm/m0-foundation`

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
| 3 | Confirm CI is green (R-025, R-114) | the `vfm-ci` workflow passes on the branch | `gh run list --workflow vfm-ci` |
| 4 | Re-run `dev-up` twice to prove idempotency end to end (R-130) | the second run changes nothing and reports what it skipped; `kind-velero` untouched | `./scripts/dev-up.sh` twice |

**Only when all four pass is M0 complete.** Record it in `vfm/docs/PROGRESS.md`
and move R-021, R-129, R-130 and R-132 to ✅ in `DEVELOPMENT_STATUS.md`.

Already done, do not redo: the first migration is applied and `migrate status`
reports in sync; `openapi.yaml` is committed and verified in sync with the
decorators; all 76 TypeScript tests, lint, format and typecheck are green.

### 2. Then M1 day 4 — users and local authentication

`VELERO_FLEET_PLAN.md` §16 day 4 (line 639–641), implementing §8.3 (line 399)
and §9 (`users`).

- First platform admin registered via a one-time setup token printed to the logs
  on first start. **No open self-signup.**
- Login and logout with argon2id, a 12-character minimum, and a breached-password
  check against a **bundled** top-100k list — §8.3 forbids an external call.
- Redis-backed sessions: httpOnly, Secure, SameSite=Lax; 12 h absolute, 1 h idle.
- CSRF double-submit token on every state-changing route.
- Per-IP and per-account rate limiting with progressive delay and lockout.

**Requirements covered:** R-088, R-091, R-092, R-093 (and the start of R-083).

**Acceptance criteria:** unit tests for password policy, the breached-list
check, session lifetime and rotation, and CSRF rejection; an integration test
for the setup-token flow proving it cannot be replayed. `make test` green.

**Files it will touch:** `vfm/server/src/auth/**` (new),
`vfm/server/prisma/schema.prisma` (session-adjacent columns only — sessions
live in Redis per §9 line 422), `vfm/packages/shared/src/**` (permission
constants land in M1 day 8).

**Dependencies:** a running dev environment (`make dev-up`) for Postgres and
Redis; `VFM_MASTER_KEY` becomes required once the first encrypted column exists
(M1 day 5, TOTP secret).

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
- Commits in session 1 bypassed the repository-root `.husky/pre-commit` hook,
  which runs `nx run-many --target=lint` over the legacy workspace. VFM lint,
  typecheck and tests were run explicitly instead.

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
