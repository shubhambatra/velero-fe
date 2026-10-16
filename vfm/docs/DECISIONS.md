# Decision log

Architecture decision records for Velero Fleet Manager. PLAN.md §0 rule 3: every
deviation from the plan, every new dependency and every contract change gets an
entry here — context, decision, consequences. Never diverge silently.

Newest entries at the bottom. Entries are append-only; supersede rather than edit.

---

## ADR-001 — Stack choices adopted from PLAN.md §4

- **Date:** 2026-10-14
- **Status:** Accepted

### Context

PLAN.md §4 pins the technology for all three components. The decision to record
is not _which_ stack (the plan dictates it) but that we adopt it as-is, and the
core invariants it exists to protect.

### Decision

Adopt §4 verbatim:

- **Agent — Go.** controller-runtime + client-go for informers and leader
  election, Velero API types imported from the pinned release, gRPC via buf,
  `log/slog` JSON, prometheus client. Distroless static, non-root, read-only
  root filesystem.
- **Control plane — TypeScript / NestJS.** Node 22+ LTS, TS `strict`,
  PostgreSQL 16 via Prisma with committed migrations, Redis/Valkey 7 with
  BullMQ, `@grpc/grpc-js` + ts-proto from the same `proto/`, argon2 + otplib +
  openid-client, Redis-backed httpOnly cookie sessions, zod validation, pino,
  prom-client, nodemailer over SMTP.
- **Web — React 19 + Vite.** TanStack Router and Query, react-hook-form + zod,
  Tailwind + shadcn/ui, recharts, a virtualized ANSI log viewer, and
  Server-Sent Events for realtime. No external fonts or CDN assets.

The six core principles of §1.1 are binding invariants, not aspirations:

|     | Invariant                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| P1  | The agent dials out only. The control plane never initiates a connection into a cluster, and holds no kubeconfig.              |
| P2  | Backup data never transits the control plane — only metadata, status, logs and commands.                                       |
| P3  | The agent is a typed command executor. No generic kubectl, no exec, no arbitrary YAML apply.                                   |
| P4  | Least privilege. Agent RBAC is exactly PLAN.md §12.2; users get only what a role grants on a specific cluster/namespace scope. |
| P5  | Every state-changing action is audited: who, what, where, when, outcome.                                                       |
| P6  | Air-gap capable. No runtime calls to the public internet, no CDN assets.                                                       |

### Consequences

- The legacy application in this repository violates P1 (it reads clusters
  directly through a kubeconfig). It is not extended or reused — see ADR-003.
- Redis is a hard dependency for sessions, agent→replica routing and job
  queues, so `/readyz` must check it from day 1.
- SSE rather than WebSockets/socket.io means proxy-friendly realtime, at the
  cost of one HTTP connection per subscriber. Section 13 load targets are
  measured against that in M7.

---

## ADR-002 — Velero version pin, support window and Go module path

- **Date:** 2026-10-14
- **Status:** Accepted
- **Supersedes:** nothing. Required by PLAN.md §4.4 and §0 rule 4.

### Context

PLAN.md §4.4 requires pinning the newest stable Velero release as
`VELERO_PRIMARY` and verifying it rather than trusting the plan's text. §4.1
warns that Velero joined the CNCF and that the repository or Go module path may
have moved away from `github.com/vmware-tanzu/velero`.

### Decision

Verified on 2026-10-14:

|                        | Value                            | How it was verified                                                                          |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `VELERO_PRIMARY`       | **v1.18.4**                      | GitHub releases API for the Velero repository                                                |
| Oldest supported minor | **v1.16.2**                      | primary minus two minors (PLAN.md §18 Q4 default); v1.16.2 is the newest patch on that minor |
| Supported minors       | 1.18, 1.17, 1.16                 | §4.4 — primary plus the two previous minors                                                  |
| Source repository      | `github.com/velero-io/velero`    | `api.github.com/repos/vmware-tanzu/velero` returns a 301 redirect to it                      |
| **Go module path**     | `github.com/vmware-tanzu/velero` | `go.mod` at tag `v1.18.4` still declares `module github.com/vmware-tanzu/velero`             |

So the repository moved but **the module path did not**. Go imports use
`github.com/vmware-tanzu/velero/pkg/apis/velero/v1` (and `v2alpha1`);
documentation links point at `velero-io/velero`.

Velero v1.18.4's `go.mod` declares `go 1.25.8`, which is the floor for the agent
module. We use the current stable toolchain, **Go 1.27.2** (PLAN.md §4.1: "latest
stable at project start").

These values are duplicated in exactly three places, which must be changed
together:

1. `packages/shared/src/velero-support.ts` (consumed by server and web)
2. `vfm/Makefile` (`make versions`, used by dev scripts and the e2e matrix)
3. this ADR

### Consequences

- The e2e matrix runs against v1.18.4 and v1.16.2 (PLAN.md §4.4).
- A server reporting a version outside the window is treated as unsupported and
  the UI degrades to read-only, rather than guessing at capabilities. The
  capability map in `agent/internal/velero/capabilities.go` lands in M2/M3.
- When Velero's module path eventually changes, only the agent's imports and
  `VELERO_GO_MODULE` move; a new ADR supersedes this one.

---

## ADR-003 — Build VFM as a new subtree beside the existing application

- **Date:** 2026-10-14
- **Status:** Accepted

### Context

This repository (`shubhambatra/velero-fe`) is a fork of `otwld/velero-ui`: an Nx
monorepo containing a Vue 3 SPA (`apps/velero-ui`) and a NestJS API
(`apps/velero-ui-api`) that reaches Kubernetes clusters **directly through a
kubeconfig**, with no database and socket.io for realtime.

PLAN.md specifies a different system in nearly every dimension:

| Dimension      | Existing application                                                       | PLAN.md requirement                                                     |
| -------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Frontend       | Vue 3 + Pinia + FormKit                                                    | React 19 + TanStack (§4.3)                                              |
| Cluster access | in-process kubeconfig client, including remote contexts (commit `62f5aee`) | outbound-only agent over mTLS gRPC (§1.1 P1, §5)                        |
| Persistence    | none                                                                       | PostgreSQL 16 + Prisma (§4.2, §9)                                       |
| Realtime       | socket.io                                                                  | Server-Sent Events (§4.3, §10)                                          |
| Identity       | passport (local/LDAP/OAuth) + CASL + `policies.csv`                        | argon2id + TOTP + OIDC, data-driven roles with per-namespace scope (§8) |
| Tenancy        | single installation                                                        | organizations, teams, per-cluster role bindings (§8.1)                  |

PLAN.md §0 is explicit that the plan wins where code and plan conflict, and
PLAN.md §14 prescribes a repository layout rooted at the repository root.

### Decision

Build VFM as greenfield code in a new **`vfm/` subtree**, containing the whole
§14 layout (`PLAN.md`, `docs/`, `proto/`, `agent/`, `server/`, `web/`,
`packages/shared/`, `deploy/`, `e2e/`, `tools/`). The existing `apps/` and
`libs/` are left untouched and keep building.

The §14 paths are reproduced exactly, one level down. This is a **deviation from
§14's root placement**, taken for the tooling reason in ADR-004.

Reused from the existing code: `libs/velero/src/models/**` — hand-written
TypeScript interfaces for the Velero `v1`/`v2alpha1` custom resources — as a
starting point for zod schemas and the proto field set. They are **copied, not
imported**, and every field is cross-checked against the pinned Velero Go types
before use, because PLAN.md §0 rule 4 forbids trusting any second-hand
description of the Velero API. Nothing else is reused.

### Consequences

- Two applications coexist in one repository. The legacy one is not maintained
  as part of this work and not kept at feature parity.
- Whether the legacy application is eventually removed is an open product
  decision, deliberately not taken here. Until it is taken, CI must keep both
  green, which is why the VFM workflow is path-filtered to `vfm/**`.
- The repository's `package.json` remains `@otwld/velero-ui` (Apache-2.0) with
  upstream homepage and issue URLs. Licensing and naming of the combined work is
  PLAN.md §18 Q6, still unanswered; the default "keep internal, decide before
  public release" applies. VFM's own name lives in one constant
  (`packages/shared/src/product.ts`) so a rename stays trivial.
- `.env` and `.env.development` are tracked in git in this fork, inherited from
  upstream. VFM never reads them and never writes to them; all VFM secrets come
  from the environment or Kubernetes Secrets (§12.1). Untracking them is a
  separate decision, flagged in PROGRESS.md.

---

## ADR-004 — pnpm workspace scoped to `vfm/`, and toolchain pins

- **Date:** 2026-10-14
- **Status:** Accepted

### Context

PLAN.md §4.5 requires a pnpm-workspace monorepo plus a Go module. The repository
root is already an Nx workspace with a committed **`package-lock.json`** (npm)
and a `packageManager` field claiming pnpm 7.27.0 — the two disagree today.
Adding a root `pnpm-workspace.yaml` would put two package managers in charge of
one root `package.json`, which breaks installs for whichever one runs second.

### Decision

- The pnpm workspace is rooted at **`vfm/`**, with its own
  `pnpm-workspace.yaml`, `package.json` (`@vfm/root`, private) and `.npmrc`. The
  repository root stays npm/Nx-owned and is not modified.
- pnpm is pinned to **10.20.0** via `packageManager` and run through
  **corepack** (ships with Node 22+). The system-wide pnpm 7.27.0 is too old for
  the toolchain in §4.3 and is bypassed, not upgraded, so other projects on the
  machine are unaffected.
- `strict-peer-dependencies=false` in `vfm/.npmrc`: React 19's ecosystem still
  carries stale peer ranges. The plan pins React 19 explicitly, so the peer
  check is relaxed rather than the framework downgraded.
- Build entrypoints are a **Makefile** (`vfm/Makefile`) rather than a
  Taskfile — §4.5 allows either, and `make` needs no extra toolchain. Targets
  are exactly those listed in §4.5 plus `doctor`, `smoke`, `lint-staged` and
  `versions`.
- Toolchain versions for this build: Go **1.27.2**, buf **1.73.0**,
  golangci-lint v2, Node **22+** (24.15.0 locally), kind, kubectl, helm and the
  Velero CLI at `VELERO_PRIMARY`.
- Targets whose component does not exist yet (Go lint before M0 day 3, proto
  codegen before M2 day 10, helm lint before M2 day 15) print exactly what is
  missing and why instead of failing or silently passing. Missing _prerequisite
  tools_ always fail loudly with install instructions — PLAN.md §0 rule 7
  forbids fake completeness.

### Consequences

- Developers run VFM commands as `make -C vfm <target>`; legacy commands keep
  working unchanged from the repository root.
- The repository root `.husky/pre-commit` gains a guarded block that lints VFM
  only when staged paths include `vfm/`. This is the only legacy file this work
  modifies.
- Two lockfiles exist (`package-lock.json` at the root, `vfm/pnpm-lock.yaml`).
  Dependency scanning in CI must cover both; the VFM workflow runs
  `pnpm audit` against the VFM lockfile only.

---

## ADR-005 — Defaults applied to PLAN.md §18 open questions

- **Date:** 2026-10-14
- **Status:** Accepted, pending owner confirmation

### Context

PLAN.md §18 lists seven open questions, each with a default that applies unless
the owner answers. The owner has not answered them. §0 rule 10 says to use the
stated default unless the question blocks work; none of them block M0.

### Decision

Proceed on the plan's defaults, recorded here so they are visible rather than
implicit:

| #   | Question                                                            | Default applied                                                                       | Where it shows up in code                                        |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Q1  | SaaS or self-hosted?                                                | Self-hosted only. Multi-org exists for MSPs and large enterprises, not SaaS billing.  | no billing tables or metering                                    |
| Q2  | Max clusters in year 1                                              | 200 (§13)                                                                             | load-test target, index and batching sizing                      |
| Q3  | Must the agent work through a proxy without HTTP/2 or long streams? | Assume HTTP/2 works; respect `HTTPS_PROXY`. A WebSocket fallback would be a v1.1 ADR. | agent chart proxy env (M2)                                       |
| Q4  | Oldest Velero running on real target clusters                       | primary minus two minors → v1.16.2                                                    | ADR-002, e2e matrix, capability map                              |
| Q5  | Is browser download of backup contents ever acceptable?             | Off by default; presigned URL only; Cluster Admin only.                               | `allowBackupContentDownload` org setting defaults to false       |
| Q6  | License and product name                                            | Keep internal; decide before public release.                                          | one product-name constant; upstream Apache-2.0 headers untouched |
| Q7  | Compliance target affecting audit retention                         | 400-day audit retention with CSV export.                                              | org audit-retention setting default                              |

### Consequences

- **Q4 and Q6 are the two that cause rework if they change.** Q4 changes the
  capability map, the CI matrix and which Velero features the UI may expose. Q6
  affects licensing of the combined work with the Apache-2.0 upstream.
- A later answer supersedes this ADR rather than editing it.

---

## ADR-006 — Two dependency substitutions against PLAN.md §4

- **Date:** 2026-10-14
- **Status:** Accepted

### Context

PLAN.md §4.2 names specific packages. Two of them are no longer the maintained
choice, discovered when `pnpm install` reported them:

1. **`prom-client`** — the registry marks 15.1.3, its final release, as
   _"prom-client has been replaced by `@prometheus-io/client`"_. The successor
   is published by the same project and exposes the same API surface
   (`Registry`, `collectDefaultMetrics`, the metric classes).
2. **`eslint` 9.x** — 9.39.2 is marked _"This version is no longer supported"_.
   ESLint 10.12.0 is current, and `typescript-eslint` 8.71.2 declares
   `eslint: ^8.57.0 || ^9.0.0 || ^10.0.0`, so the pairing is supported.

### Decision

- Use **`@prometheus-io/client` 0.16.1** wherever the plan says `prom-client`.
  The metrics listed in §13 are unaffected; only the import path changes.
- Use **ESLint 10.12.0** with `@eslint/js` 10.0.1 and `typescript-eslint`
  8.71.2 across the `vfm/` workspace.
- Drop **`@nestjs/cli`** and **`@nestjs/schematics`**. The Nest 12 CLI line
  depends on TypeScript ~6.0.2 and its schematics peer-require `typescript >=
6`, which conflicts with the TypeScript 5.9.3 that `@nestjs/swagger` 12 and
  the rest of the workspace are built against. The CLI only provided
  `nest build` and `nest start`, which are replaced by `tsc -p
tsconfig.build.json` and `tsx watch src/main.ts`. This also removes the
  webpack, ts-loader and `@swc/cli` peer chain.

### Consequences

- Neither substitution changes any requirement in the plan — the capabilities
  §4.2 asked for are all present.
- Dropping the Nest CLI means code generation via `nest generate` is
  unavailable; files are written by hand, which is how this codebase already
  works.
- Revisit the TypeScript major when `@nestjs/swagger` supports 6.x, so the
  server can move with the rest of the Nest ecosystem.

---

## ADR-007 — Prisma 7 configuration model and the pg driver adapter

- **Date:** 2026-10-14
- **Status:** Accepted

### Context

PLAN.md §4.2 specifies "PostgreSQL 16 via **Prisma** (migrations committed)"
without naming a version. Prisma 7 — the current stable line — changed two
things the plan's shape assumes:

1. `datasource.url` is no longer accepted in `schema.prisma`. Migration and
   introspection commands read the connection string from a `prisma.config.ts`
   file, and the runtime client receives it through a **driver adapter**.
2. `prisma.config.ts` is not loaded through dotenv, so `.env` is not picked up
   automatically.

### Decision

- Adopt Prisma **7.10.0** rather than pinning back to 6.x. The newer model is
  where the ecosystem is going, and the migration workflow the plan actually
  depends on — committed migrations, `migrate deploy`, drift detection — is
  unchanged.
- Runtime connections go through **`@prisma/adapter-pg` 7.10.0** over `pg`.
  This is required by Prisma 7, and it has an independent benefit: the
  connection pool is ours to size, which matters because the control plane runs
  N replicas against one database (§3.2). The pool is currently capped at 10
  per replica and is revisited against the §13 scale targets during the M7
  load test.
- `server/prisma.config.ts` reads `DATABASE_URL` from the environment and
  loads `server/.env` through Node's built-in `process.loadEnvFile` when that
  file exists, rather than adding a dotenv dependency. The URL is **never**
  committed (§12.1).
- The datasource block is omitted when `DATABASE_URL` is unset, so
  `prisma generate` works without a reachable database — a clean checkout must
  build in CI and in an air-gapped image build (§1.1 P6).

### Consequences

- Anyone used to `url = env("DATABASE_URL")` in the schema will not find it;
  the comment in `schema.prisma` points at this ADR.
- `pg` becomes a runtime dependency of the control plane.
- Prisma 8 is already in release-candidate. Upgrading is a separate decision
  and needs its own ADR; nothing here depends on 8.

---

## ADR-008 — `mfa_recovery_codes` as a table, which PLAN.md §9 does not list

- **Date:** 2026-10-15
- **Status:** Accepted

### Context

PLAN.md §8.3 requires "recovery codes (10, hashed)" but §9's table list has no
home for them. The two candidates were a JSON column on `users` and a dedicated
table.

### Decision

A dedicated `mfa_recovery_codes` table: `(id, user_id, code_hash, used_at)`.

The deciding factor is **single use under concurrency**. With a table, spending
a code is one atomic statement:

```sql
UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL
```

Two requests presenting the same code cannot both succeed — the second matches
zero rows. In a JSON column the same operation is a read-modify-write, and
making it safe would need `SELECT … FOR UPDATE` or a hand-written `jsonb_set`
with a guard clause, which is the kind of code that looks correct and is not.

A second, smaller reason: a table makes "how many codes does this user have
left" an indexed count rather than a JSON scan, which the MFA status endpoint
calls on every page load.

Also added in the same migration: `users.mfa_last_time_step`, a BigInt holding
the highest TOTP time step already accepted for that user. Without it a TOTP
code is replayable for its whole 30-second window.

### Consequences

- §9's table list is now a subset of what exists. The schema header says so, and
  this ADR is the record. Future additions of this kind get the same treatment
  rather than silently diverging.
- `users` cascades to `mfa_recovery_codes`, so deleting a user cleans up.
- The table is **not** org-owned and carries no `org_id`: recovery codes belong
  to a user, who may be a member of several orgs. The org-scoping extension of
  §8.1 (M1 day 6) must therefore not treat it as org-scoped.

---

## ADR-009 — SHA-256 for recovery codes and API tokens, argon2id for passwords

- **Date:** 2026-10-15
- **Status:** Accepted

### Context

PLAN.md §8.3 says recovery codes are "hashed" and that API tokens are "stored
hashed", without naming an algorithm, while specifying argon2id for passwords.
Using argon2id everywhere looks like the conservative choice.

### Decision

Hash **passwords** with argon2id, and **recovery codes and API tokens** with
SHA-256.

The reason argon2id exists is that human-chosen passwords are low-entropy and
reused, so an attacker with the hashes guesses them offline; a deliberately slow
hash makes that expensive. Neither property applies to a value the server
generates: a recovery code is 80 bits of CSPRNG output and an API token will be 256. There is nothing to guess, so the slow KDF buys no security.

It does cost something. Verifying a recovery code compares against up to ten
stored hashes, which with argon2id at our parameters is roughly half a second of
CPU per attempt — a denial-of-service lever on an unauthenticated-adjacent
endpoint.

The hash still matters: a database leak must not yield usable codes, and
SHA-256 of an 80-bit random value is not invertible in any practical sense.

### Consequences

- Recovery-code verification is an indexed equality lookup on the hash, which
  is only safe _because_ the input is high-entropy; the same shortcut would be
  wrong for passwords.
- The comparison is still done in constant time after the lookup, so the
  outcome never depends on a partial comparison in the query layer.
- M1 day 9 applies the same reasoning to API tokens. If either value ever
  becomes user-chosen, this ADR must be revisited — that would change the
  threat model entirely.

## ADR-010 — Org scoping by client extension, the invites table, and starting M1 before M0 exits

- **Date:** 2026-10-15
- **Status:** Accepted

### Context

PLAN.md §8.1 requires that every query be org-scoped in a way that cannot be
forgotten, and asks for a test that fails if one is not. Day 6 also needs
invitations, which §9 does not list as a table, and a way for a person with no
account to accept one, because §16 day 4 forbids open self-signup.

### Decision

**Scoping.** A Prisma client extension (`src/prisma/org-scope.ts`) wraps every
operation. A model is org-owned when it has an `orgId` column — derived from the
generated client, not hand-listed — so a new tenant table is scoped the moment it
has the column. Org-owned data can only be reached inside
`prisma.inOrg(orgId, …)`, which injects the filter and refuses a conflicting
`orgId` on reads and writes, or inside `prisma.unscoped(reason, …)`, whose
reason is mandatory. With neither, the query throws. The ambient scope is an
`AsyncLocalStorage`, and the wrapper `await`s inside it because a Prisma query is
a lazy promise that would otherwise execute after the scope was left.

Two tests make "impossible to forget" checkable: one fails if a model is neither
org-owned nor on the named exemption list (`User`, `MfaRecoveryCode`,
`Organization`), and one pins every `unscoped()` call site and every use of raw
SQL, which no extension can see.

**Tables.** `teams`, `team_members` and `invites` are added. `team_members`
repeats `org_id` so the extension treats it like every other org-owned table.
`invites` is not in §9; it stores a SHA-256 of the token (ADR-009), is bound to
an address, and is consumed by one conditional `UPDATE`.

**Org creation** is platform-admin-only and the creator becomes Owner. A
platform admin has no implicit access to an org's data (§8.1 gives the flag the
job of bootstrapping, not of reading). A non-member receives 404, not 403.

**Account creation.** `POST /invites/register` is the only user-creation path
after first-time setup. It is public but requires a valid token for an address
with no account; an existing account must sign in and use `/invites/accept`,
which keeps CSRF protection and avoids a forced-join by a forged cross-site
request.

**OpenAPI generation** now runs from the compiled output. `tsx` emits no
decorator metadata, so any provider mixing `@Inject(token)` with typed
parameters cannot resolve under it; the generator runs the same JavaScript the
server ships.

**Milestone gating.** M1 days 4–6 proceed while M0's exit criteria (B-1, B-2)
are unmet, at the owner's direction on 2026-10-15. This is a recorded deviation
from §0 rule 1, not a waiver: M0 still has to pass before M2, which is the first
work that needs the agent.

### Consequences

- Every service that touches an org-owned model has to say which org. That is
  the point, and it is what forces day 8's RBAC code to do the same.
- `inOrg()` makes the filter structural; it does not replace the membership
  check, which `OrgAccessService.require` performs on every `/orgs/{orgId}` route.
- An un-awaited Prisma promise returned from `inOrg()`'s callback would run
  outside the scope and throw; the wrapper's `await` prevents that for callers.
- `SMTP_HOST` unset makes invitations fail with 503 rather than silently not
  sending. Lockout notification is best-effort and only logs on failure.

## ADR-011 — OIDC identity linking, and `oidc_identities`

- **Date:** 2026-10-16
- **Status:** Accepted

### Context

PLAN.md §8.3 asks for per-org OIDC with JIT provisioning and group → team
mapping, and says nothing about how an IdP identity is tied to a local user.
The obvious rule — match on the email claim — makes the identity provider a
way to sign in as, or silently join an org as, any existing account.

### Decision

Sign-in resolves in this order, inside the provider's org scope:

1. **`(provider, sub)` already linked** → that user. Never re-matched by email,
   so an IdP changing a user's address cannot move the account.
2. **First sight of the subject:** the ID token must carry an `email` with
   `email_verified: true`. If an account with that address exists it is linked
   **only if it is already a member of the provider's org**; otherwise sign-in
   is refused — JIT does not override this.
3. **No account at all:** created only when the provider has `jit_enabled`
   (default off), with a null password hash and a `MEMBER` membership.

`oidc_identities` is added for (1); §9 does not list it. A disabled account is
refused at every step. Every refusal returns the same `sso=failed` redirect and
logs the reason, so the callback is not an account oracle.

**Other choices**

- State is single use (`GETDEL`), and additionally bound to the browser by an
  httpOnly `SameSite=Lax` cookie, which stops an attacker feeding a victim their
  own authorization code. Nonce and the PKCE verifier are bound to the request.
- IdP authentication is **not** assumed to include MFA: a new Owner/Admin, or a
  user with a local factor, is gated exactly as after a password login.
- Mapped teams are IdP-managed. Only teams named in a provider's mappings are
  touched; a manual addition to one is removed at the next sign-in. Teams not
  named are never changed.
- Changing a provider's issuer is refused while identities are linked: a `sub`
  is unique only within one issuer.
- Production refuses an `http` issuer; dev allows it so Dex needs no TLS.

### Consequences

- An org admin who wants everyone from the IdP in must turn JIT on; adopting
  SSO never opens an org by itself.
- An existing user in a _different_ org cannot be pulled in by an IdP; they
  need an invite. This is deliberately stricter than most products.
- The issuer is fetched by the control plane on an admin's say-so, which is an
  SSRF surface (an admin can point it at an internal URL). Mitigated only by
  requiring Owner/Admin and https in production; an egress allow-list is left
  to M7's threat model (§12.3).
- The dev Dex client now registers `/api/v1/auth/oidc/callback`; the old
  `/api/auth/...` URIs never matched a route.

## ADR-012 — RBAC: a pure engine in `@vfm/shared`, `role_bindings` without a cluster FK

- **Date:** 2026-10-16
- **Status:** Accepted

### Context

PLAN.md §8.2 defines four built-in roles, org Owner/Admin as implicit Cluster
Admin, and a namespace-scoping rule it calls "the most security-critical
function in the codebase". §9 lists `role_bindings` with a `cluster_id`, but the
`clusters` table does not exist until M2.

### Decision

- **The decision function is pure and lives in `packages/shared`**
  (`rbac.ts`): bindings and facts in, `{allowed, reason}` out. The server
  loads facts (`RbacService`) and calls it; the web app can call the same code
  to hide controls. 66 table-driven cases run with no database and were
  mutation-checked (turning `every` into `some`, or removing the
  cluster-scoped check, fails tests).
- **Deny by default and on doubt.** Unknown permission, unknown role,
  unreadable scope, non-member, missing namespaces, unknown namespace labels
  and an empty selector all deny. An empty `matchLabels` is refused rather
  than read as "everything", which is what Kubernetes would do.
- **Scoped bindings grant only namespaced permissions** plus `cluster:read`
  and `storage:read`. `storage:write`, `advanced:write` and `cluster:manage`
  need a whole-cluster binding: they change the cluster, not a namespace.
- **A restore is checked on source and target.** `restoreNamespaces()` returns
  both sides of a mapping; checking only the target would let a user scoped to
  `dev` restore `prod`'s data into `dev` and read it there.
- **Grants add up across bindings** (user and team), but each namespace must be
  covered by a binding that carries the permission itself.
- **`backup:download` needs the org setting for everyone**, owners included
  (`allowBackupContentDownload`, default off).
- **`role_bindings.cluster_id` is a plain UUID, no foreign key.** M2 adds the
  `clusters` table and the constraint. Until then nothing can verify a cluster
  exists, which is why every authorization on an unknown cluster id resolves
  to "no binding" for members and "allowed" only for org Owner/Admin.
- **`role` is a string key, not an enum**, so v1.1 custom roles need no
  migration. `subject_id` is polymorphic (user or team) and so cannot be a
  foreign key; the service validates the subject on create and deletes the
  bindings when a member leaves the org or a team is deleted — otherwise
  re-inviting someone would silently restore access granted before they left.
- **404 versus 403:** a caller who cannot see the cluster at all gets 404; one
  who can see it but lacks the permission gets 403.
- **`@RequirePermission` demands the permission across the whole cluster** by
  default. A handler that checks namespaces itself opts in with
  `checkInHandler`, and the guard then only confirms the permission is held
  somewhere. Forgetting the handler-side check therefore fails closed.
- **Authorization is read from the database on every request**; there is no
  cache, so revoking a binding applies to the next request. Revisit if it
  becomes a hot path (M2 SSE fan-out is the likely one).

### Consequences

- The guard runs after the global `SudoGuard`, so an unauthorized caller on a
  sudo-protected route sees "sudo required" before the 404/403. It reveals a
  route that is public in the OpenAPI document anyway.
- Binding management is not audited yet (day 9 adds the interceptor).
- SELECTOR bindings can be created but grant nothing until M3 supplies
  namespace labels; the tests are named for that.
- Fixed in passing: `sudoRequired`, `mfaRequired` and `mfaPendingReason` were
  documented by the guards but dropped by the problem+json filter, so a client
  could not tell a step-up prompt from a plain 403. They are now an
  allow-listed extension member set.

## ADR-013 — Audit log: trigger-enforced append-only, written from response middleware

- **Date:** 2026-10-16
- **Status:** Accepted

### Context

PLAN.md §9 says `audit_events` is append-only by revoking UPDATE/DELETE from the
application DB role, with a separate retention role. §16 day 9 asks for "an
audit interceptor on all mutating routes".

### Decision

- **A trigger, plus the REVOKE.** In every deployment where the migrating role
  owns the table (all of dev and CI), revoking privileges from the owner is a
  no-op. A `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE`
  statement trigger raise for everyone; only direct members of the NOLOGIN
  `vfm_audit_retention` role may DELETE. Tests prove UPDATE, DELETE,
  deleteMany and TRUNCATE all fail from the owning role. A production
  deployment should still run the app as a non-owner role holding INSERT and
  SELECT only; the trigger is the backstop, not a replacement.
- **No foreign keys, nullable `org_id`.** History must outlive the org, user or
  cluster it describes, and a cascade would make deleting an org a way to erase
  its log. Some events precede any org (a failed login).
- **Middleware on `finish`, not a Nest interceptor.** Interceptors run after
  guards, so a request refused by authentication, CSRF, RBAC or sudo never
  reaches one — and a refusal is exactly what an auditor wants. It is generic:
  a new mutating route is audited without a decorator.
- **Names, never values.** Details hold the route pattern, status and the _names_
  of body fields. Bodies carry passwords, tokens and client secrets; a
  key-based redactor is a safety net, not the plan. A test greps every row for
  known secrets.
- **Written after the response.** A failing insert cannot turn a successful
  action into an error, and is logged at error level. The cost is that the
  row is not in the action's transaction. Commands (M2) are written in the
  same transaction as the command, per §6; this path is for control-plane
  mutations.
- **Actors:** USER, or TOKEN with `onBehalfOf`. Emails are looked up at read
  time rather than stored, so an erasure takes effect in the view.

### Consequences

- An unauthenticated request that hits a route (a failed login) is recorded
  with no actor and no address that was tried.
- `GET` is not audited, so a read of the audit log or inventory leaves no row;
  the CSV export, which is bulk egress, records itself explicitly.
- Retention (400 days) is only a role and a trigger exception for now; the job
  itself is M6 (R-101).
- The table grows without bound until then, and e2e runs leave rows behind
  because they cannot be deleted. Tests count deltas instead of totals.

## ADR-014 — API tokens: opt-in per route, narrowing only

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

- Format `vfm_` + 43 base64url characters (256 bits); SHA-256 at rest (ADR-009);
  shown once; `prefix` (12 chars) stored for recognition.
- **Bearer auth is opt-in** (`@AllowsApiToken()`), the reverse of sessions.
  Handlers written for browsers read CSRF tokens, re-authentication times and
  the active org, and a token has none. Opt-in also keeps token management,
  passwords, MFA and every sudo operation out of a token's reach by default.
  Today only `GET /clusters/{id}/my-access` opts in; M2+ routes choose.
- **Narrowing only.** At use time the owner's grants are intersected with the
  token's `permissions` and `clusterIds` inside the pure engine
  (`token-limit`). A token cannot widen, outlive a demotion, or survive the
  owner's removal from the org (revoked in the same transaction) or disabling.
  `null` for a field means "no extra limit", not "every permission".
- **Pinned to one org.** A `/orgs/{other}/…` path is 404 for a token even when
  its owner belongs to that org.
- **Creation needs sudo; revocation does not.** Minting a persistent credential
  from a hijacked session is the classic persistence step, while being unable
  to revoke during an incident would be perverse. This reads §8.3's "any
  delete" as applying to resources, not credential revocation.
- CSRF is skipped only for requests that _authenticated_ with a token, not for
  any request carrying an Authorization header. SudoGuard refuses tokens
  outright.

### Consequences

- A token request has no session, so `GET /me/*` is closed to tokens.
- No per-token rate limit or IP allow-list yet (M7).
- Token use is audited by the middleware only for mutating routes, and none
  accept tokens yet; read use shows only as `last_used_at`.

---

## ADR-015 — The agent protocol contract (M2 day 10)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

`proto/vfm/agent/v1/` holds six files (`common`, `enrollment`, `velero`,
`command`, `inventory`, `logs`, plus `gateway` for the service and envelopes).
Velero specs (`BackupSpec`, `RestoreSpec`, `ScheduleSpec`, BSL/VSL specs, hooks,
download kinds) were written field by field from the pinned
`velero@v1.18.4` Go types read out of the module cache, not recalled.

### Deviations from the plan's sketch (all deliberate)

- `RenewRequest`/`RenewResponse` are `RenewCertificateRequest`/`...Response`:
  `buf lint` STANDARD requires `<Rpc>Request`. Wire-irrelevant.
- `AgentGateway` keeps its name; `SERVICE_SUFFIX` is waived on that service only
  (inline `buf:lint:ignore`), as is the request/response naming on `Connect`,
  whose messages are the stream envelopes `AgentMessage`/`ServerMessage`.
- Velero's **deprecated** `defaultVolumesToRestic` is not exposed; its
  replacement `defaultVolumesToFsBackup` is. Nothing the UI needs is lost.
- Velero's `*bool` fields are proto3 `optional bool`, so "unset, let Velero
  default" is distinguishable from `false`. A plain bool would silently turn
  every omitted field into an explicit override (tested on both ends).
- `BackupResourceHook` has only an `exec` arm in v1.18.4, so `ExecHook` is
  flattened into `pre`/`post`.
- `CreateBackup`/`CreateSchedule`/... take a `spec` message plus
  `advanced_spec_json` (the one escape hatch, §5.2), not raw YAML.
- Credentials cross the wire only as `CredentialSecret` on BSL/VSL upserts; every
  other secret-bearing field is a `SecretKeyRef`. There is **no `ResourceKind`
  for Secret**, so a snapshot cannot even name one (§5.3; tested).
- Inventory objects are `ResourceItem{kind, ns, name, uid, resourceVersion,
object_json}`. The JSON is the agent's sanitised view and is treated by the
  server as semi-trusted input (size cap, schema-validated into extracted
  columns in M3 day 17). Typing every synced kind as its own message would
  triple the contract for no safety gain, because the server must validate
  either way.
- Added `CommandAck.state` (ACKED/RUNNING) to carry the §5.4 `ACKED → RUNNING`
  step the sketch did not model, and `CreatedObject`/`DownloadSummary` result
  details so the server can correlate a command to the object it produced.

### Tooling

`buf` 1.73.0 is installed through npm into `~/.local/buf` and Go 1.27.2 into
`~/.local/go` (checksum-verified against go.dev), both without root. That clears
the compile half of B-1: the agent builds, vets and its tests pass for the first
time. `make` and `golangci-lint` are still absent. Generated stubs are
committed (`agent/internal/pb`, `server/src/gateway/pb`) and excluded from
eslint and prettier. New server dependencies: `@bufbuild/protobuf` 2.15.0 and
`@grpc/grpc-js` 1.14.5, both over two weeks old.

### Consequences

`buf breaking` in CI compares against `main`, which has no `vfm/proto` yet; the
first run is the real test of that job (recorded in PROGRESS.md).

---

## ADR-016 — Internal CA, bootstrap tokens and the cluster tables (M2 day 11)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

- **Tables.** `clusters`, `cluster_bootstrap_tokens`, `agent_certificates` (PLAN.md
  §9) plus `certificate_authority`, which §9 does not list. The CA has to live
  somewhere shared, because "generated on first start" with several replicas
  means all of them must end up signing with the same key.
- **`org_id` on the two child tables.** §9 gives them only `cluster_id`. They carry
  a denormalised `org_id` so the org-scoping extension (ADR-010) covers them like
  every other table and a query on them cannot forget the tenant. Enrollment and
  certificate authentication are the two places that cannot know the org up front
  (the caller is identified by a token or a certificate, not a session), and use
  `unscoped()` with a stated reason; both call sites are on the reviewed list in
  `org-scope.test.ts`.
- **The CA row is not org-owned** (`NOT_ORG_OWNED`), and is a singleton: id `1`,
  created with `createMany({skipDuplicates})`, so concurrent first starts race
  safely and every replica loads the winner's row. The private key is
  envelope-encrypted (`CryptoService`, context `ca.private_key`) and never
  returned by any API.
- **Crypto.** ECDSA P-256 only, for the CA, agent leaves and the gateway's server
  certificate. The CA is 10 years, `pathLen 0`; agent leaves are 7 days, client
  auth only, `CA:FALSE`. Implemented with `@peculiar/x509` 2.1.0 (Node has no
  X.509 issuance API) over Node's WebCrypto; verification of presented
  certificates uses Node's own `X509Certificate`.
- **Nothing in a CSR but the public key is trusted.** The control plane sets the
  subject and the single SAN `spiffe://vfm/cluster/{id}` itself; the CSR's
  self-signature is checked as proof of key possession; a non-P-256 key is
  refused.
- **Bootstrap tokens.** 32 random bytes, base64url, SHA-256 at rest (the same
  reasoning as ADR-009), 24 h, bound to the cluster, one live token per cluster
  (issuing a new one deletes the old unused one). Burned with a conditional
  `UPDATE ... WHERE used_at IS NULL AND expires_at > now()` in the same
  transaction that records the certificate and moves the cluster to `ENROLLED`.
  Every failure (unknown, expired, used, disabled cluster, fingerprint mismatch)
  returns the same message so the endpoint is not an oracle. A _bad CSR_ is the
  agent's mistake, so it is reported specifically and **does not burn the token**.
- **Fingerprint.** Recorded at first enrollment. A later enrollment from a
  different `kube-system` UID is refused until an admin issues a token with
  `resetFingerprint: true`.
- **Revocation is by absence as well as by flag.** The gateway accepts a serial
  only if it exists, is unrevoked, is unexpired and its cluster is not disabled.
  Deleting a cluster cascades its certificate rows away, which therefore locks the
  agent out without a separate step. "Rotate certificate" revokes everything and
  issues a token (the agent must enrol again); "disable" revokes and blocks
  enrollment until "enable".
- **Renewal overlaps.** `RenewCertificate` issues a new certificate and leaves the
  old valid until it expires. Revoking at once would lock out an agent that
  crashed between receiving the new certificate and persisting it. The window is
  bounded by the 7-day lifetime, and rotate exists for the leak case.
- **Existence check in the RBAC guard.** With real clusters the guard now 404s a
  cluster id that is not in the org (`assertClusterInOrg`), where before an Owner
  got an empty 200 for any UUID. The `role_bindings.cluster_id` foreign key that
  ADR-012 deferred is added in the same migration.
- **Install command.** Generated server-side (`install-command.ts`), every
  interpolated value validated against a strict pattern before it can appear in a
  shell snippet an operator pastes with cluster-admin rights. The CA is embedded
  through a quoted heredoc. **The chart does not exist until M2 day 15**; the
  command names `AGENT_CHART_REF` (default
  `oci://ghcr.io/shubhambatra/charts/vfm-agent`, a placeholder) and the values
  `controlPlane.address`, `controlPlane.caBundle`, `enrollment.token`, which the
  chart must adopt.
- **Permissions.** Adding a cluster is Owner/Admin and needs sudo. Per-cluster
  operations use `cluster:manage` through the RBAC guard; delete, disable, enable,
  token reissue and rotate also need sudo, as they mint or revoke credentials.

### Not done here (deliberately)

- No rate limit on the enrollment endpoint beyond the 256-bit token: brute force is
  not feasible, and per-IP limits belong with the gateway's other limits (M7).
- The gRPC listener, `Connect` and the live revocation of open streams are day 13;
  `Enroll`/`RenewCertificate` over the wire is the next increment of day 11.
