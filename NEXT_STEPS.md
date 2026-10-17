# Next steps

**Updated:** 2026-10-17 (session 7, M5 day 30) · **Branch:** `vfm/m0-foundation`

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

| #   | Task                                                                                                                                                                                         | Acceptance criteria                                                                       | Verify with                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Clear B-2, then build both clusters and pass the smoke test (R-129, R-130)                                                                                                                   | `velero backup create` reaches phase `Completed` on `vfm-a` **and** `vfm-b`               | `./scripts/dev-up.sh && ./scripts/smoke.sh` in `vfm/deploy/dev`                             |
| 2   | ~~Compile/vet/test~~ done 2026-10-16 (Go 1.27.2 in `~/.local/go`, `export PATH=$HOME/.local/go/bin:$PATH`); still to do: install `golangci-lint` and run it. Verify the agent (R-021, R-132) | `go build` and `go vet` clean, unit tests pass, `golangci-lint` clean, `go.sum` committed | `cd vfm/agent && go mod tidy && go build ./... && go test ./... && golangci-lint run ./...` |
| 3   | ~~Confirm CI is green~~ — **done**: green on `ee17789`. The Go jobs begin running once `go.sum` is committed in task 2                                                                       | all jobs pass                                                                             | `gh run list --workflow 'VFM CI'`                                                           |
| 4   | Re-run `dev-up` twice to prove idempotency end to end (R-130)                                                                                                                                | the second run changes nothing and reports what it skipped; `kind-velero` untouched       | `./scripts/dev-up.sh` twice                                                                 |

**Only when all four pass is M0 complete.** Record it in `vfm/docs/PROGRESS.md`
and move R-021, R-129, R-130 and R-132 to ✅ in `DEVELOPMENT_STATUS.md`.

Already done, do not redo: migrations are applied to both `vfm` and `vfm_test`
(re-run `prisma migrate deploy` against `vfm_test` after pulling a new
migration — the e2e suite fails with "table does not exist" otherwise);
`openapi.yaml` is committed and in sync; 355 unit tests, 121 e2e tests and 121 shared tests, lint,
format, typecheck and build are green; M1 days 4–8 are complete and
verified.

### 2. ~~M1 days 4, 5 and 6~~ — **done**

Day 4 `1f0162d`, day 5 `5a8bc63`, day 6 `b124e5b`. Details in
`vfm/docs/PROGRESS.md`; design in ADR-008, ADR-009 and ADR-010. Do not redo them.

### 3. ~~M1 day 7 — OIDC~~ — **done** in session 5 (`f6fe5f8`)

R-090 verified against Dex; design in ADR-011. Do not redo it. Dex is on
`:55556`; the e2e suite now needs it running (`make dev-up`).

### 4. ~~M1 day 8 — RBAC engine~~ — **done** in session 6

R-085, R-086, R-087 verified; design in ADR-012. Do not redo it. The engine is
`packages/shared/src/rbac.ts`; a route opts in with `@RequirePermission(...)`
and gets `404`/`403` handling for free. A handler that must look at namespaces
passes `{ checkInHandler: true }` and calls `RbacService.require()` itself —
without that flag the guard demands a whole-cluster grant, so forgetting fails
closed.

### 5. ~~M1 day 9~~ — **built** in session 6; two small items remain

Audit log (ADR-013), API tokens (ADR-014), their `/tokens` page and the UI are
in. **Before the checkpoint:**

- ~~Exercise the UI flows in a browser~~ — done; see the follow-up entry in
  `vfm/docs/PROGRESS.md`. Left over: SSO provider edit/delete, invite revoke,
  member role change and removal, a narrow viewport, and an accessibility pass.

Then ⛔ **HUMAN CHECKPOINT** (plan line 662): the human reviews the RBAC model
(ADR-012) and the auth flows (ADR-008…011, 014) before M2 starts. M0's exit
criteria are still unmet (B-1, B-2).

### 6. M2 — started at the user's instruction (session 7)

- **Day 10 done** (proto contract, ADR-015): `vfm/proto/vfm/agent/v1/*.proto`,
  generated Go and TS stubs committed. Regenerate with
  `cd vfm/proto && ~/.local/buf/node_modules/.bin/buf generate` (needs network:
  remote plugins).
- **Day 11 done** (ADR-016): CA, clusters API, bootstrap tokens, gRPC gateway
  (`Enroll`/`RenewCertificate`; `Connect` authenticates then UNIMPLEMENTED),
  add-cluster UI. Driven live; see PROGRESS.md.
- **Day 12 done** (ADR-017): `agent/internal/{identity,gateway}`, wired into the
  leader task. Run Go tooling with `export PATH=$HOME/.local/go/bin:$HOME/go/bin:$PATH`.
- **Day 13 done** (ADR-018): `server/src/streams`, a real `Connect`, live revocation.
- **Days 10-15 are built** (ADR-015…020). **M2's exit criteria are not met** and what remains is not
  something more code here can finish:
  1. Clear B-2 (inotify, needs root), then `./scripts/dev-up.sh` in `vfm/deploy/dev` to build both kind clusters.
  2. Build and load the agent image: `docker build -t ghcr.io/shubhambatra/vfm-agent:0.1.0 vfm/agent`, then
     `kind load docker-image ... --name vfm-a` (and `vfm-b`). No registry publishes it yet.
  3. In the UI, **Add cluster**, copy the generated command, and run it against each kind cluster
     (the gateway address must be reachable from the cluster: set `GATEWAY_PUBLIC_ADDRESS` and
     `GATEWAY_HOSTNAMES` accordingly). Confirm **Connected** and the Velero version.
  4. ⛔ **Human checkpoint**: install the agent on one real, non-kind cluster and confirm it connects.
     (The cluster page already shows the Velero version and plugins, the agent version, an "update available"
     badge and a Refresh button.)
- **M3 day 16 done** (ADR-021): `agent/internal/inventory`.
- **M3 day 17 done** (ADR-022): `server/src/{inventory,events}`, `velero_resources`, SSE `/api/v1/stream`.
- **M3 day 18 done** (ADR-023): fleet overview, cluster overview, live updates (`web/src/lib/{events,fleet}.ts`, `pages/{overview,cluster}-page.tsx`).
- **M3 day 19 done** (ADR-024): lists + detail pages, namespace visibility, cursor pagination (`server/src/inventory/{projections,resources.*}.ts`, `web/src/pages/cluster-{lists,detail}.tsx`).
- **M3 day 20 done** (ADR-025): `FetchDownload` pipeline, `velero_files` cache, backup/restore log and detail panels (`agent/internal/velero/download.go`, `server/src/downloads/`, `web/src/components/file-panel.tsx`).
- **M4 day 21 done** (ADR-026): backup create / delete / run-now (`agent/internal/velero/backup*.go`, `server/src/backups/`).
- **M4 day 22 done** (ADR-027): backup wizard, typed delete, command notifications, `GET …/access` (`web/src/pages/backup-wizard.tsx`, `web/src/lib/backup-form.ts`, `web/src/components/{toasts,confirm-delete}.tsx`).
- **M4 day 23 done** (ADR-028): restore create / delete (`agent/internal/velero/restore*.go`, `server/src/restores/`).
- **M4 day 24 done** (ADR-029): restore wizard with impact summary, `CheckNamespaces` (`web/src/pages/restore-wizard.tsx`, `web/src/lib/restore-form.ts`, `agent/internal/velero/namespaces.go`).
- **M4 day 25 done** (ADR-030): schedules — create, update, pause/resume, delete (`agent/internal/velero/{schedule,cron}.go`, `server/src/schedules/`, `GET …/schedules/{name}`, `web/src/pages/schedule-wizard.tsx`, `web/src/components/{cron-builder,backup-fields}.tsx`, `web/src/lib/{cron,schedule-form}.ts`).
- **M4 day 26 done** (ADR-031): storage locations — upsert, delete, set default; transient credential written by the agent to a Secret it owns (`agent/internal/velero/storage.go`, `server/src/storage/`, `server/src/commands/transient.ts`, `web/src/pages/location-form.tsx`, `web/src/lib/location-form.ts`).
- **M4 day 27 done** (ADR-032): write-ops sweep — golden paths 2–7 and 10 at the control plane, credentials grep over DB, API, audit and all logs, agent policy shown in the UI (`server/test/golden-paths.e2e.test.ts`, `server/src/rbac/access.controller.ts`).
- **M4 is complete in code.** Its exit criteria (golden paths 1–11 on a real Velero, then the ⛔ human backup and restore drill on a non-kind cluster) need B-2 and the user.
- **M5 day 28 done** (ADR-033): core inventory — `agent/internal/inventory/core.go`, `WatchScope` in `gateway.proto`, `server/src/inventory/{watch-scope.service,projections}.ts`, `GET …/inventory/{nodes,namespaces,pods,pvcs,events}`.
- **M5 day 29 done** (ADR-034): workloads UI — `web/src/pages/workloads.tsx`, `server/src/inventory/coverage.ts`.
- **M5 day 30 done** (ADR-035): live log sessions — `agent/internal/logs/streamer.go`, `server/src/logs/*`, `LOG_SESSION_END_REASON_COMPLETED` in `logs.proto`; routes `POST|DELETE …/log-sessions`, `GET …/log-sessions/:id/stream` (SSE: `chunk`, then one `ended`) and `GET …/log-shortcuts`. Nothing is stored; the agent is started when the first stream opens.
- **Next: M5 day 31 — log viewer polish and tests** (plan line 755): the web log viewer (virtualized list with `@tanstack/react-virtual`, ANSI colours, follow, pause, wrap, search in the buffer, timestamps, download the visible buffer, a 50 000-line ring buffer), a logs button on each pod container row and the Velero server / node-agent shortcuts from `GET …/log-shortcuts`, and the day's tests: limits, permission denial, `logStreamDeniedNamespaces` server- and agent-side, cleanup when the browser disconnects (most of the server half already has e2e coverage in `server/test/logs.e2e.test.ts`). The stream has no replay (nothing is stored): the viewer must say so when it reconnects, and `ended` carries `reason` (`completed`, `stopped`, `pod_gone`, `timeout`, `evicted`, `denied`, `error`, `idle`, `revoked`) and a short message. `/access` now reports `logs:read` and the agent policy's reason in `blocked`. M5 exit criteria (latency under 2 s from kind, 10 sessions stable) need B-2; they held against a synthetic source (median 2 ms).
- The plan's ⛔ checkpoint after M1 was waived by the user; M0 is still unmet.

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
