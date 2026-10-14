# Progress log

Required by PLAN.md §0 rule 2. One entry per working session, newest first.
**A new session starts by reading this file and PLAN.md.**

Each entry records: date, milestone/day, what was completed, test status, what is
next, and blockers. Anything incomplete goes under **Deferred** — PLAN.md §0
rule 7 forbids reporting stubbed work as done.

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

| Gate | Result |
|---|---|
| `pnpm run test` (all TypeScript workspaces) | **76 passed** — shared 13, server 40, web 23 |
| `pnpm run lint` (eslint + prettier) | clean |
| `pnpm run typecheck` (`tsc --noEmit` ×3) | clean |
| `pnpm --filter @vfm/server run build` | clean |
| `prisma migrate dev` then `migrate status` | migration applied; "Database schema is up to date" |
| OpenAPI regeneration | `git diff --exit-code` clean — the committed contract matches the decorators |
| `./scripts/dev-up.sh` compose stage | all six services healthy, both buckets verified |
| `./scripts/dev-down.sh --clusters-only` | removed `vfm-a`, explicitly left the unrelated `velero` cluster untouched, kept the compose stack up |
| Go build / vet / test | **not run — Go is not installed** |
| `./scripts/smoke.sh` | **not run — blocked, see Blockers** |
| CI | **not run — nothing pushed at the time of writing** |

### Three real defects found by running the code rather than reading it

1. `compose up --wait` treats *any* exited container as a failure, so the
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
