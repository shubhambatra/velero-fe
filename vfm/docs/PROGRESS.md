# Progress log

Required by PLAN.md §0 rule 2. One entry per working session, newest first.
**A new session starts by reading this file and PLAN.md.**

Each entry records: date, milestone/day, what was completed, test status, what is
next, and blockers. Anything incomplete goes under **Deferred** — PLAN.md §0
rule 7 forbids reporting stubbed work as done.

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
- `eslint` (ESLint 10, `strictTypeChecked`) and `tsc --noEmit` clean for every
  workspace that exists.
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

M0 day 2 — dev environment: docker compose (PostgreSQL 16, Valkey 7, MinIO with
two buckets, Mailpit, Dex), kind clusters `vfm-a` and `vfm-b` with Velero
v1.18.4 + the AWS plugin against MinIO, CSI hostpath driver, node-agent and
sample workloads; idempotent `make dev-up` / `dev-down`; `make smoke` asserting a
`velero backup create` reaches `Completed` on both clusters.

### Blockers

None for day 1.
