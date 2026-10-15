# Progress log

Required by PLAN.md §0 rule 2. One entry per working session, newest first.
**A new session starts by reading this file and PLAN.md.**

Each entry records: date, milestone/day, what was completed, test status, what is
next, and blockers. Anything incomplete goes under **Deferred** — PLAN.md §0
rule 7 forbids reporting stubbed work as done.

---

## 2026-10-15 — M1 day 4: users and local authentication

**Note on milestone gating.** PLAN.md §0 rule 1 says a milestone does not start
until the previous one's exit criteria pass. M0's do not: `smoke.sh` has never
run (blocker B-2) and the Go agent has never compiled (B-1). The owner asked to
proceed with day 4 regardless. Day 4 depends on neither — it needs only
PostgreSQL and Redis, both of which the compose stack provides — so nothing
here is built on unverified ground. The two blockers remain open.

### Completed (§16 day 4, §8.3)

- **First-admin bootstrap.** One-time token printed to the logs on first start
  while `users` is empty; stored as a SHA-256 digest in Redis with a 24 h TTL;
  burned atomically with `GETDEL`. No open self-signup, and the flow closes
  permanently once a user exists.
- **argon2id** at 19 MiB / t=2 / p=1, 12-character minimum, plus a bundled
  97 747-entry breached-password list (UK NCSC via SecLists, normalised and
  gzipped to 260 KB). Bundled because §8.3 says "no external calls" and §1.1 P6
  forbids runtime internet access. Stored parameters are upgraded in place on
  login when they fall behind.
- **Sessions** in Redis (§9): 12 h absolute and 1 h idle enforced
  independently, rotation, and "sign out everywhere". The user row is re-read
  on every request, so disabling an account revokes immediately.
- **CSRF** double-submit, compared against the token in the session rather
  than only a second cookie.
- **Brute-force protection**: per-account and per-IP counters over fixed
  windows, progressive delay applied before the outcome is known, timed
  lockout.
- **Deny by default**: `SessionGuard` and `CsrfGuard` are global; a route is
  open only with an explicit `@Public()`.
- `TRUST_PROXY` added to the env schema, because rate limiting keys on the
  client address and `X-Forwarded-For` must only be believed deliberately.
- `/auth/*` endpoints: `GET|POST /auth/setup`, `POST /auth/login`,
  `POST /auth/logout`, `DELETE /auth/sessions`, `GET /auth/me`. `openapi.yaml`
  regenerated and committed.

### Test status — actually executed

| Gate                                          | Result                                          |
| --------------------------------------------- | ----------------------------------------------- |
| `pnpm run test` (unit, all workspaces)        | **140 passed** — shared 13, server 104, web 23  |
| `pnpm --filter @vfm/server test:e2e`          | **27 passed** against real PostgreSQL and Redis |
| `pnpm run lint` (eslint 10 + prettier)        | clean                                           |
| `pnpm run typecheck`                          | clean                                           |
| `pnpm --filter @vfm/server run build`         | clean, and the bundled list reaches `dist/`     |
| OpenAPI regeneration → `git diff --exit-code` | clean                                           |
| Go build / vet / test                         | **not run — B-1**                               |
| `smoke.sh`                                    | **not run — B-2**                               |

New: 64 server unit tests and the whole 27-test e2e suite. A CI job now runs
the e2e suite against service containers and fails if the committed OpenAPI
contract drifts from the decorators.

### Seven real defects found this session

**Caught by the tests**

1. `/healthz` returned 401 once the global guard landed — which would have
   restart-looped every pod, since the kubelet's probe is unauthenticated.
   Caught by the e2e suite, fixed with `@Public()` on the health controller.
2. `tsc` emits only JavaScript, so the bundled password list never reached
   `dist/` and the built server could not start. The build copies it now, and a
   test asserts the path resolves from both `src/` and `dist/`.
3. A missing list file made startup **hang** rather than fail: a
   `createReadStream` error does not surface through the readline async
   iterator. Now checked up front and piped through `stream.pipeline`.

**Caught only by running the built server** — every one of these was invisible
to the test runner, which configures SWC with set-semantics class fields and
resolves workspace packages through Vite. The lesson is recorded here because
it will recur: a green suite does not mean the service starts.

4. **Nest DI returned `undefined` for every injected service.**
   `useDefineForClassFields` defaults to true for ES2022+, and under those
   semantics the fields generated from TypeScript parameter properties are
   declared _after_ being assigned, so each reads back as undefined. Set to
   false in the server tsconfig, which decorator-based DI requires.
5. **`@vfm/shared` shipped raw TypeScript**, so the built control plane could
   not load it (`Cannot find module .../product.js`). It now has a real dual
   build — CommonJS for the server, which compiles to CJS and cannot
   `require()` ESM, and ESM for the web app, because Rollup cannot see named
   exports through a CommonJS entry. Each half carries a one-line package.json
   declaring its module type; built on install so no consumer has to remember.
6. **`express` was imported directly but declared only transitively.** It
   resolved locally through pnpm's layout and was missing on a clean install,
   which is how CI found it. Pinned to the version `@nestjs/platform-express`
   itself depends on, so the tree holds exactly one express.
7. **The documented dev workflow crashed.** `.env.example` sets
   `LOG_PRETTY=true` but `pino-pretty` was not a dependency, and nothing loaded
   `server/.env` despite the README instructing you to create it. Added as a
   devDependency, the transport degrades to JSON when unresolvable, and
   `main.ts` loads the file outside production with real environment variables
   still winning.

### Deferred

- **The lockout notification email** of §8.3. The lockout itself is enforced;
  the SMTP mailer arrives with org invites on day 6, and the notification lands
  with it. `AuthService` logs the event at warn in the meantime.
- **MFA gating.** `login` marks a session `mfaPending` when the user has MFA
  enabled, but `SessionGuard` does not yet refuse such a session — that is day
  5, together with enrolment. The gap is currently unreachable: nothing in day
  4 can set `mfaEnabled`, which defaults to false.
- Everything else previously deferred stands: the Go agent (B-1), `smoke.sh`
  (B-2), the §14.1 seed script (needs day 6 tables), `libs/velero` model reuse
  (M2 day 10), and a test asserting the security headers (arrives with the
  next HTTP suite).

### Blockers

Unchanged: **B-1** (no Go toolchain) and **B-2** (host inotify limits too low
for the kind clusters). Both need root; `sudo` here requires a password.
Commands are in `NEXT_STEPS.md`.

### Next

M1 day 5 — MFA and sudo mode: TOTP enrol/verify/disable, 10 hashed recovery
codes, org-enforced MFA, and the sudo re-auth endpoint with its guard
decorator. `VFM_MASTER_KEY` becomes **required** at that point, because
`mfa_secret_encrypted` is the first encrypted column (§9).

---

## 2026-10-14 — M0 days 2 and 3: dev environment and service skeletons

### Completed — day 2, dev environment (§14.1, §16 day 2)

- `deploy/dev/docker-compose.yml`: PostgreSQL 16, Valkey 7, MinIO with one
  bucket per cluster, Mailpit, and Dex with a static user per built-in role.
  Every image pinned, every port published on 127.0.0.1 only, host ports moved
  into the 5xxxx range because 5432 is already taken on this machine.
- `deploy/dev/versions.env`: every version pin in one place, including the kind
  node image by digest. `dev-up.sh` fails if these and `docker-compose.yml`
  drift apart.
- `deploy/dev/scripts/`: `dev-up.sh`, `dev-down.sh`, `sample-workloads.sh`,
  `smoke.sh`, `lib.sh`. Plain bash, runnable without `make`, idempotent, and
  loud about anything they skip. `assert_owned_cluster` makes it impossible for
  them to touch any kind cluster other than `vfm-a`/`vfm-b`.
- Cluster build: CSI snapshot controller + hostpath CSI driver +
  `VolumeSnapshotClass`, Velero v1.18.4 with the AWS plugin against that
  cluster's MinIO bucket and the node agent enabled, and sample workloads in
  namespace `demo` including a PVC whose payload checksum is recorded for e2e
  golden path 3.
- MinIO is reached from the clusters by joining it to the `kind` docker network
  and pointing a selector-less Service with a hand-written EndpointSlice at it,
  so the host publishing can stay loopback-only.

### Completed — day 3, service skeletons (§16 day 3)

- **`server/`**: zod-validated config, pino JSON logging with request
  correlation, RFC 9457 problem+json errors, strict CSP and security headers,
  `/healthz`, `/readyz` (Postgres + Redis, 503 when down), `/metrics` on port
  9090, `redact()`, Prisma 7 with the pg driver adapter, and the first
  migration (`users`, `organizations`, `memberships`). OpenAPI 3.1 generated
  from the decorators and committed.
- **`web/`**: React 19 + Vite shell, TanStack Router and Query, Tailwind with
  shadcn-style primitives, dark/light theme, error boundary, typed API client
  that parses problem+json, and an accessibility baseline.
- **`agent/`**: config, slog JSON, health and metrics server, kube client,
  Lease-based leader election. **Not compiled or tested — see Deferred.**

### Test status — actually executed

| Gate                                        | Result                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm run test` (all TypeScript workspaces) | **76 passed** — shared 13, server 40, web 23                                                         |
| `pnpm run lint` (eslint + prettier)         | clean                                                                                                |
| `pnpm run typecheck` (`tsc --noEmit` ×3)    | clean                                                                                                |
| `pnpm --filter @vfm/server run build`       | clean                                                                                                |
| `prisma migrate dev` then `migrate status`  | migration applied; "Database schema is up to date"                                                   |
| OpenAPI regeneration                        | `git diff --exit-code` clean — the committed contract matches the decorators                         |
| `./scripts/dev-up.sh` compose stage         | all six services healthy, both buckets verified                                                      |
| `./scripts/dev-down.sh --clusters-only`     | removed `vfm-a`, explicitly left the unrelated `velero` cluster untouched, kept the compose stack up |
| Go build / vet / test                       | **not run — Go is not installed**                                                                    |
| `./scripts/smoke.sh`                        | **not run — blocked, see Blockers**                                                                  |
| CI                                          | **not run — nothing pushed at the time of writing**                                                  |

### Defects found by running the code rather than reading it

1. `compose up --wait` treats _any_ exited container as a failure, so the
   one-shot bucket provisioner could never satisfy it. It is now started and
   checked separately with a bounded wait.
2. The `kind` nodes could not reach MinIO through the bridge gateway, because
   the compose stack publishes it on 127.0.0.1 only. MinIO now joins the `kind`
   network as a second attachment instead of the host publishing being widened.
3. `veleroMinorOf('1.18.x')` parsed as `1.18`. A wildcard is not a version and
   the capability map keys off this value, so the patch component must now be
   numeric. Caught by the unit test that was written alongside it.

Plus two smaller ones: a `localStorage` test whose spy never installed (jsdom's
storage object is proxy-backed, so the test passed without exercising the
failure path at all), and `skip()` appending "(already present)" to messages
that said the opposite.

And four that only the first CI run could find:

4. The Trivy action tag is v-prefixed, so `@0.33.1` did not resolve.
5. `actions/setup-node@v5` activates the `packageManager` field of the nearest
   package.json. At the repository root that is the legacy Nx workspace's pnpm
   7.27.0 with an unverifiable sha1, so the action failed before any step of
   ours ran.
6. The Go jobs gated on `go.mod`, but `go build` needs a committed `go.sum` to
   verify modules. They now gate on `go.sum` and write a run summary pointing
   at blocker B-1.
7. Lint and typecheck failed on a fresh install because `@prisma/client` has
   no generated types until `prisma generate` runs. Added as a postinstall.

Two `pnpm audit` high advisories (`mysql2`, `deepmerge-ts`, both reaching us
only through the Prisma CLI's transitive tree) are forced to patched versions
with pnpm overrides rather than suppressed, as §12.1 requires.

### Deferred

- **The Go agent is unverified.** `go`, `make`, `buf` and `golangci-lint` are
  not installed. ~2 900 lines of agent source and tests are committed but have
  never been compiled; `go.sum` does not exist and `go mod tidy` must be run
  once. External imports were checked by hand against `go.mod` and are
  consistent, which is not the same as compiling.
- **`make smoke` has not passed**, so the M0 exit criterion is not met. See
  Blockers.
- **The §14.1 seed script** (platform admin, two orgs, a user per role, both
  clusters enrolled) needs tables that do not exist until M1 day 6, so it lands
  there.
- **`libs/velero` model reuse** stays deferred to M2 day 10, when each field can
  be cross-checked against the pinned Velero Go types.
- **No test asserts the security headers yet**; that arrives with the first HTTP
  integration test in M1.

### Blockers

- **B-1 — Go toolchain absent.** Owner-installed by agreement; commands are in
  `NEXT_STEPS.md`.
- **B-2 — host inotify limits too low for the kind clusters.**
  `fs.inotify.max_user_instances` is 128 and `max_user_watches` is 65 536; two
  two-node clusters need 512 / 524 288. Below that, `kube-proxy` on a worker
  crash-loops with "too many open files" and nothing on that node can reach a
  Service IP — which is exactly what happened, surfacing minutes later as a
  snapshot-controller rollout timeout. `dev-up.sh` now checks this in preflight
  and fails immediately with the fix. Raising it needs root, and `sudo` on this
  machine requires a password, so it could not be done from this session:

  ```
  sudo sysctl -w fs.inotify.max_user_instances=512
  sudo sysctl -w fs.inotify.max_user_watches=524288
  ```

  The half-built `vfm-a` cluster was deleted so a later `dev-up` rebuilds it
  cleanly rather than skipping a broken one.

### Next

Clear B-1 and B-2, then finish the M0 exit criteria: `./scripts/dev-up.sh`
followed by `./scripts/smoke.sh` green on both clusters, and the agent built
and tested. Then M1 day 4 — users and local authentication. Details in
`NEXT_STEPS.md`.

---

## 2026-10-14 — M0 day 1: repo skeleton, docs, CI

### Completed

- `vfm/` subtree created with the PLAN.md §14 layout (one level down, per
  ADR-003): `PLAN.md`, `docs/`, `proto/`, `agent/`, `server/`, `web/`,
  `packages/shared/`, `deploy/`, `e2e/`, `tools/`.
- pnpm workspace scoped to `vfm/` (`pnpm-workspace.yaml`, `@vfm/root`,
  `.npmrc`), pnpm 10.20.0 pinned via corepack so the repository-root npm/Nx
  workspace is untouched (ADR-004).
- `vfm/Makefile` with the §4.5 targets — `setup gen lint test e2e dev-up
dev-down build helm-lint` — plus `doctor`, `smoke`, `lint-staged`, `versions`.
  Missing prerequisite tools fail loudly with install instructions; components
  that do not exist yet report why they are skipped.
- Lint and format configuration: `eslint.config.mjs` (flat,
  `strictTypeChecked`), `.prettierrc`, `.editorconfig`, `.golangci.yml`,
  `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).
- `packages/shared`: the single product-name constant required by §0 rule 4
  (`product.ts`), and the Velero support window (`velero-support.ts`) with
  version parsing, with 13 unit tests.
- `docs/DECISIONS.md` with ADR-001 (stack and the P1–P6 invariants), ADR-002
  (Velero pin + module path, verified), ADR-003 (subtree beside the legacy app,
  with the conflict table), ADR-004 (pnpm scoping and toolchain pins), ADR-005
  (§18 defaults applied).
- `docs/RELEASE_CHECKLIST.md`: PLAN.md §17 tracked from day 1.
- `proto/` scaffold: `buf.yaml`, `buf.gen.yaml` (Go + ts-proto outputs), README
  stating the contract rules. No messages yet — those are M2 day 10.
- `.github/workflows/vfm-ci.yml`: lint, test, audit and buf jobs, path-filtered
  to `vfm/**` so legacy-only commits are unaffected.
- `.husky/pre-commit` at the repository root: guarded block running VFM lint
  only when staged paths include `vfm/`. The only legacy file modified by this
  work.

### Verified facts recorded in ADR-002

- `VELERO_PRIMARY` = **v1.18.4**; oldest supported = **v1.16.2**.
- Velero's GitHub repository is now `velero-io/velero` (301 from
  `vmware-tanzu/velero`), but the **Go module path is still
  `github.com/vmware-tanzu/velero`** at v1.18.4. PLAN.md §4.1 flagged this as
  needing verification; it is now verified.

### Test status

- `@vfm/shared`: 13 tests passing.
- `eslint` (ESLint 10, `strictTypeChecked`) and `tsc --noEmit` clean.
- `prettier --check` clean, excluding vendored upstream manifests.

### Deferred

- **Go, buf, make, golangci-lint are not installed on this machine.** Day 1 does
  not need them; day 3 needs Go, and M2 needs buf. Install commands are in the
  session notes. The Makefile's `lint-go`/`test-go`/`gen-proto` targets report
  the absence rather than passing vacuously.
- **`libs/velero` model reuse** (ADR-003): deferred to M2 day 10, when the proto
  field sets are written and each field can be cross-checked against the pinned
  Velero Go types. Copying them earlier would mean trusting them.
- **`buf breaking`** is configured but only becomes meaningful in M2 once
  messages exist.

### Flagged, not acted on

- `.env` and `.env.development` are **tracked in git** in this fork (inherited
  from upstream `otwld/velero-ui`). VFM neither reads nor writes them. Untracking
  them rewrites nothing but does change the legacy app's checkout behaviour, so
  it is left as a separate decision for the owner.

### Next

M0 day 2 — dev environment (completed later in the same session, see below): docker compose (PostgreSQL 16, Valkey 7, MinIO with
two buckets, Mailpit, Dex), kind clusters `vfm-a` and `vfm-b` with Velero
v1.18.4 + the AWS plugin against MinIO, CSI hostpath driver, node-agent and
sample workloads; idempotent `make dev-up` / `dev-down`; `make smoke` asserting a
`velero backup create` reaches `Completed` on both clusters.

### Blockers

None for day 1.
