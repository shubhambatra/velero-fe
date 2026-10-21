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

### Addendum — the gateway listener (M2 day 11, part 2)

- **One port, optional client certificate.** `Enroll` has no certificate yet, so the
  listener _requests_ a client certificate and verifies it against the internal CA
  but does not _require_ one; `RenewCertificate` and `Connect` refuse a caller with
  no verified, unrevoked certificate per RPC. grpc-js's `createSsl` cannot express
  this (requesting a certificate also rejects its absence), so the gateway uses
  `experimental.createCertificateProviderServerCredentials`. That API is
  experimental, which is why `@grpc/grpc-js` stays pinned to an exact version and
  the behaviour is covered by real-handshake tests rather than mocks.
- **The server certificate rotates in place.** A provider (`GatewayIdentityProvider`)
  swaps the gateway's own 30-day certificate hourly-checked, 10 days before expiry,
  without restarting the listener; a test reads the served serial before and after.
- **grpc-js race, worked around.** A certificate provider that answers synchronously
  reports its identity before the server has registered its watcher, so the server
  believes it has no credentials and drops every connection. The provider answers on
  a microtask. Without the workaround the symptom is "socket disconnected before
  secure TLS connection was established" on every call.
- **`Connect` authenticates, then answers UNIMPLEMENTED** until day 13 builds the
  stream registry and routing. It is wired so an unauthenticated or revoked agent is
  already refused exactly as it will be later.
- **Limits.** 4 MB messages (§5.6) enforced by the server; the enrollment fields are
  additionally size-capped well below that.
- **Agents pin the CA.** A client that trusts a different CA fails the handshake
  before the application sees the request, so the operator's bootstrap token is not
  consumed by it (tested).

---

## ADR-017 — The agent's connection manager (M2 day 12)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

- **Packages.** `internal/identity` (key, CSR, parsed identity, `Store`),
  `internal/gateway` (the manager, backoff). Command execution and informers attach
  later through `Manager.OnMessage` and the `Send` queue; nothing here executes a
  command.
- **The key is born in the cluster.** ECDSA P-256, PKCS#8, generated per enrollment
  and per renewal; only a CSR leaves the process. Persisted as a
  `kubernetes.io/tls`-shaped Secret (`tls.key`, `tls.crt`, `ca.crt`) named by
  `VFM_CREDENTIALS_SECRET` (default `vfm-agent-credentials`), which the agent's
  RBAC will reach by name only (§12.2, chart on day 15). An empty Secret means "not
  enrolled", so the chart can pre-create it.
- **Pinning.** Before enrollment the agent trusts only `controlPlane.caBundle`; after,
  only the CA stored with its identity. TLS 1.3 minimum. A server presenting a
  certificate from any other CA is refused before the token is sent (tested), so a
  man in the middle cannot harvest a bootstrap token.
- **Token handling.** `VFM_ENROLLMENT_TOKEN` is environment-only, with no flag,
  so it never appears in a process list; the config log reports presence only
  (tested). It is used only when no identity is stored. If the token is spent and the
  Secret write then fails, the error says so explicitly: the operator must issue a new
  token. That window is unavoidable without server-side two-phase enrollment.
- **Reconnect.** Exponential backoff 1 s → 60 s with full jitter and a Min/2 floor
  (agents do not reconnect in lockstep); the backoff resets only after a stream has
  lasted 30 s, so a server that accepts and immediately drops is still backed off.
  `Unauthenticated` is logged as an operator-actionable condition (disabled, deleted,
  rotated) and still retried, which also picks up a corrected Secret.
- **Renewal** at two thirds of the lifetime, on the live stream's connection, with a
  new key; the new identity is persisted before it is used; the stream is not dropped.
  A renewed certificate naming a different cluster is rejected.
- **Graceful stop** half-closes the stream and waits up to 2 s for the server to end
  it, so the server records a clean close. (The stream's context is deliberately
  detached from the shutdown context: tying them together aborted the RPC before the
  half-close was delivered, which the first test run caught.)
- **Hello policy.** Reports the built-in default policy (§5.5) until day 14 loads the
  `vfm-agent-policy` ConfigMap. Since nothing executes yet, the default is also what is
  enforced.
- **Fingerprint** is the `kube-system` namespace UID, read at every connect.

### Tooling

`golangci-lint` v2.14.0 and `govulncheck` v1.9.0 run locally from `~/go/bin`
(`go install`, built with Go 1.27.2); both clean. `-race` needs cgo and there is no C
compiler on this machine, so the race detector runs only in CI. The fake gateway's
configuration goes through a locked `configure()` for that reason.

### Verification

Eleven Go tests against an in-process control plane over real gRPC and real TLS
(enroll, no re-enroll, missing token, reconnect, refused credentials, timed renewal,
graceful close, CA pinning, bad token, queue overflow, backoff). Cross-checked once by
hand against the real TypeScript gateway with a throwaway program: enrolled, got a
certificate for the right cluster, authenticated `Connect` (reaching the server's
day-13 placeholder) and backed off.

### Not done here

Leader election across two real replicas against a cluster (blocked on B-2 for kind),
the Secret store against a real API server (the unit tests use a fake clientset), and
the stream's server half (day 13).

---

## ADR-018 — The agent stream on the server: registry, routing and liveness (M2 day 13)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

- **A `streams` module**, separate from `gateway` and `clusters`, so the clusters
  module can revoke and the gateway can attach without depending on each other.
- **Routing.** `vfm:agent:{clusterId}` = `{replica, session}`, 60 s TTL, refreshed by
  every heartbeat and by a 20 s timer. `locate()` says which replica holds an agent;
  `send()` writes locally or publishes to `vfm:gateway:replica:{id}` and reports
  whether anyone received it, so a caller can queue instead of losing a message.
- **One control channel** (`vfm:gateway:control`) carries `close` messages. They
  serve both supersession (a new stream ends every other for the same cluster, here
  or on another replica; the newest wins) and revocation (`disable`, `delete` and
  `rotate-certificate` publish a close, which is the live half of §5.1 step 6; the
  deny-list stops reconnects). The subscriber is a dedicated connection with an
  offline queue and unlimited retries, unlike the shared fail-fast client.
- **Hello is a gate, not a record.** It must be the first message, within 10 s, once
  only. Protocol versions other than the supported set, a fingerprint different from
  the cluster's, and a disabled cluster are refused with distinct gRPC statuses
  (`FAILED_PRECONDITION`, `UNAUTHENTICATED`). What is stored from it is sanitised:
  control characters stripped, strings capped at 128, at most 50 plugins and
  capabilities, at most 100 namespaces. The agent is semi-trusted (§12).
- **Absent means restricted.** A Hello with no policy is stored as read-only with
  nothing allowed, never as open: "unknown" must not render as "everything allowed".
- **Liveness is two mechanisms.** A per-stream watchdog closes a stream silent for
  45 s (`DEADLINE_EXCEEDED`). A sweeper, run by whichever replica wins a short Redis
  lock, marks `CONNECTED` clusters whose `last_seen_at` is stale **and** whose route
  has expired as `DISCONNECTED`, which is the only thing that notices a replica that
  was killed. Cleanup after a stream never overwrites a newer connection's status or
  resurrects a `DISABLED` cluster.
- **A stream ends when its certificate does.** The server closes it at the
  certificate's `notAfter`; the agent, which renewed at two thirds of the lifetime,
  reconnects with the new one.
- **Bug found by testing, worth recording.** Node's async iterator destroys a duplex
  stream when the peer half-closes, so the server never sent its closing status and a
  gracefully stopping agent waited for nothing. The server iterates with
  `destroyOnReturn: false`.

### Verified live

Two real server processes sharing one database and Redis raced at first start and
agreed on a single CA row. A real Go agent enrolled and connected to replica 1; the
cluster showed `CONNECTED` with its Velero details. Killing replica 1 with `SIGKILL`
left the cluster `CONNECTED` until the sweeper on replica 2 marked it `DISCONNECTED`
56 s later. The same stored identity then connected through replica 2 with no
re-enrollment, the route named replica 2, and a `SIGTERM` to the agent produced a clean
close and an immediate `DISCONNECTED` with the route cleared.

### Not done here

Delivery guarantees and re-sending on reconnect are day 14 (`send()` returns false
when an agent is unreachable; it does not queue). Inventory and event messages are
accepted and handed to `onAgentMessage` handlers, of which there are none yet. The
certificate-expiry close is implemented but not exercised by a test (a seven-day
certificate cannot be waited out and the issuer lifetime is not injectable).

---

## ADR-019 — The command pipeline (M2 day 14)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

**Server (`commands` module, `commands` table)**

- **The row is the source of truth, written before anything is sent.** A command is
  `QUEUED` first, then written to the stream if the agent is reachable. A crash between
  the two loses nothing; an unreachable agent just means the command waits for the next
  Hello, when every unfinished command is re-sent oldest first with the same id.
- **A pure state machine** (`command-state.ts`) implements §5.4: it never moves
  backwards and never leaves a terminal state. Late, duplicate and out-of-order messages
  (a result before its ack, an ack twice) are ignored, not errors. Every transition is one
  conditional `UPDATE ... WHERE status IN (...)`, so concurrent writers cannot regress a
  command.
- **An agent can only report on its own cluster's commands.** Looked up by id, the
  command's `cluster_id` must equal the stream's. A compromised cluster that learns another
  cluster's command id gets nothing and is logged. (Mutation-checked: removing the check
  makes the test fail.)
- **Results are display data.** Error text is stripped of control characters and capped
  at 1 000 characters; only a result that actually finished the command may update cluster
  facts, so a late duplicate for a command that already timed out cannot rewrite them.
- **Cancel is allowed only before the agent acknowledges** (`QUEUED`/`SENT`), as the plan
  says; afterwards `409`. The agent is also told to drop it if it already received it.
- **Timeouts.** A lock-guarded sweeper marks overdue unfinished commands `TIMED_OUT`
  (`TIMEOUT`) and sends `CancelCommand`. Default deadline is per operation (60 s for
  `REFRESH_STATUS`). A cluster with 100 unfinished commands refuses more (`429`): a stuck
  agent must not grow the table without bound.
- **A closed set of operations** (`ops.ts`). Only `REFRESH_STATUS` exists; the M4
  mutations are added there with their own validation. `refresh-status` needs only
  `cluster:read`: it changes nothing the caller cannot already see.
- **Refresh on connect.** After each accepted Hello the server enqueues its own
  `REFRESH_STATUS` (not on behalf of any user, `requestedBy` empty) unless one is already
  unfinished, so the UI shows Velero's version without anyone asking. Switchable with
  `COMMANDS_REFRESH_ON_CONNECT` (off in the test harness so suites that assert on exactly
  what an agent receives stay quiet).
- **Secrets.** There is no column for credential material. When M4 adds BSL/VSL upserts
  their credentials must be envelope-encrypted before they reach the `payload` column.

**Agent (`dispatch`, `policy`, `velero` packages)**

- **The agent is not a remote shell.** It runs only operations with a registered handler
  (the allowlist), only after the policy allows them, at most once per command id, and
  answers everything, refusals included, with a typed result. An operation without a
  handler is `INVALID_ARGUMENT`, not silence. A panicking handler becomes `INTERNAL`
  without the panic text; the agent survives.
- **Idempotency.** An LRU of 10 000 outcomes, answered from memory on a duplicate, also
  across a restart: persisted every 30 s (when changed) as gzip JSON in
  `BinaryData` of the `vfm-agent-state` ConfigMap, trimmed oldest-first to stay under
  900 KiB (a ConfigMap holds 1 MiB). A corrupt or unreadable cache starts empty and says
  so; the worst case is a command executed twice, which creation by label already
  tolerates. The outcome is recorded _before_ it is sent, so a lost send is answered from
  the cache on re-delivery.
- **Policy (§5.5)** is read from the `vfm-agent-policy` ConfigMap and reloaded every 30 s.
  Absent means the default. **Malformed means lockdown, not default**: unknown keys (a
  typo such as `allowRestor`), non-booleans or overlong names make the agent refuse every
  change until fixed, and say why. A restore is refused if it names a protected namespace,
  maps into one, or names none at all (which means all) without excluding every protected
  namespace. `RefreshServerStatus` is the one command allowed in read-only mode.
- **`RefreshServerStatus`** creates a `ServerStatusRequest` labelled
  `vfm.io/command-id` / `vfm.io/requested-by` and annotated `vfm.io/managed=true`,
  looking first for one with the same command-id label so a re-run does not duplicate it,
  waits for `status.phase == Processed`, reads the version and up to 100 plugins, and
  deletes the request with its own context so a missed deadline does not leave objects in
  the customer's cluster. Kubernetes errors are mapped to typed codes without the raw API
  body. It uses the dynamic client; Velero's Go types arrive with M3.
- **Shutdown** cancels running commands and waits for them to report.

### Verified

Server: 19 e2e tests (real gRPC/mTLS), a state-machine table, a mutation check on the
cross-cluster rule. Agent: dispatcher, policy, cache/persistence and handler tests, plus
the whole agent path (manager → dispatcher → result) against an in-process control plane,
and a mutation check on the duplicate guard. Live: a real server with the real Go manager,
dispatcher and handler (a fake Kubernetes API standing in for Velero) — connect, the
server's own refresh, execution, `SUCCEEDED` after one attempt, version and plugins on the
cluster; and with Velero absent, `FAILED` / `NOT_FOUND` with the explanatory message.

### Not verified

Against a real Velero and a real API server (kind is blocked on B-2): the dynamic client
against real CRDs, the state ConfigMap and policy ConfigMap against a real API server
(fake clientset only), and RBAC for them (the chart is day 15). No UI action yet; the
clusters page shows the Velero version but not the plugin list.

---

## ADR-020 — The agent chart, image and stream hardening (M2 day 15)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

- **Chart `vfm/deploy/helm/vfm-agent`.** Values are exactly what the "Add cluster" page tells
  the operator to set (`controlPlane.address`, `controlPlane.caBundle`, `enrollment.token`);
  a server test reads the real `values.yaml` so the two cannot drift. `values.schema.json`
  makes `helm install` fail, rather than the agent fail later, when the address or CA is
  missing or not a certificate, when replicas are zero, or when a policy key is misspelt.
- **RBAC is §12.2 and nothing else.** A ClusterRole with read on nodes, namespaces, pods,
  PVCs, events and `get` on `pods/log`; a Role in the Velero namespace for `velero.io`
  resources and Secrets; a Role in the agent's namespace for its own Secret, ConfigMaps and
  Lease. `create` cannot be restricted by `resourceNames`, so it is the only verb granted by
  namespace alone; `get`/`update` on the agent's own objects are limited to those names, and
  the owner's policy ConfigMap is `get`-only. The agent does not hold the cluster-wide Secret
  read it would need to be a skeleton key.
- **The chart is tested against the agent, not just against itself.** `test/chart` renders it
  with `helm template` and: diffs the RBAC against §12.2 written out in the test; asserts no
  wildcard, no `exec`/`attach`/`portforward`, no Secret in the ClusterRole; checks every
  `VFM_*` variable it sets against the agent's own config constants (both "missing" and
  "invented") and feeds the rendered environment to the agent's real `config.Load`; parses the
  rendered policy ConfigMap with the agent's real parser and checks the default equals the
  agent's default policy; checks the token is a Secret reference, optional, and appears
  nowhere inline. Three deliberate mutations (a Secret in the ClusterRole, a wildcard verb,
  a wrong env prefix) each failed the suite and were reverted.
- **Hardened pod.** Non-root (65532), `readOnlyRootFilesystem`, no privilege escalation, all
  capabilities dropped, `RuntimeDefault` seccomp, resource requests and limits, two replicas
  with a preferred anti-affinity and a PDB with `minAvailable: 1`. A changed policy or CA
  rolls the pods (config checksum annotation). The enrollment token may be removed after
  enrollment: the `secretKeyRef` is `optional`.
- **Custom CA / proxy.** The agent pins the control plane to `controlPlane.caBundle` and
  nothing else, so a TLS-intercepting proxy cannot sit in the middle; `HTTP_PROXY`,
  `HTTPS_PROXY` and `NO_PROXY` are passed through for CONNECT proxies. There is no knob to
  trust a system store for the control plane, on purpose.
- **Image.** Two-stage build, `CGO_ENABLED=0`, `-trimpath`, stripped, onto
  `gcr.io/distroless/static-debian12:nonroot`; both bases pinned by digest. Built (69.5 MB) and
  run locally read-only, as 65532, with `--cap-drop ALL`; outside a cluster it fails with a clear
  message. CI builds it on every change so the Dockerfile cannot rot.
- **A naming mistake worth recording.** While writing the chart I found that the docs and two
  `os.Getenv` calls used `VFM_AGENT_*` while the agent's real prefix is `VFM_`. The config
  constants were right; the prose and two raw reads were not. The raw reads now use constants,
  the docs are corrected, and the chart test above would have caught it.

### Hardening tests (PLAN.md §16 day 15)

| Scenario                                                  | Where                                                                                                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent killed mid-command, before any outcome was recorded | `dispatch/hardening_test.go` (re-delivery runs it exactly once more, then replays) and `commands.e2e` (a `RUNNING` command is re-delivered without regressing)                   |
| Agent killed after recording but before sending           | `dispatch/hardening_test.go` (replayed from the persisted cache, not run again)                                                                                                  |
| Server replica killed                                     | `gateway/pipeline_test.go` (abrupt kill, restart on the same address, agent reconnects with its identity and work resumes); `streams.e2e` and the live two-process run of day 13 |
| Revoked certificate                                       | `gateway.e2e`, `streams.e2e`, `clusters.e2e` (disable, delete, rotate; open streams closed)                                                                                      |
| Wrong-cluster fingerprint                                 | `streams.e2e` (Hello refused), `clusters.e2e` (re-enrolment from another cluster refused)                                                                                        |
| Bootstrap token reuse                                     | `clusters.e2e` (replay and six concurrent enrolments, exactly one wins), `gateway.e2e`                                                                                           |

### Not verified

The chart installed on a real cluster, the image pulled from a registry (none is published),
the RBAC accepted by a real API server (a rule the API server rejects would only show then),
leader election between two real replicas, and `-race` locally. All need the kind clusters
(B-2) or a registry; none is something a unit test can stand in for.

---

## ADR-021 — Inventory sync on the agent (M3 day 16)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

- **Scope.** The eleven Velero kinds of §5.3, in the Velero namespace only, through the dynamic
  client and informers (no Velero Go types yet). Core kinds (Node, Namespace, Pod, PVC, Event) are
  M5 day 28, as the README has always said; the plan's day 16 line names the Velero kinds.
- **Capability detection.** Which kinds the cluster serves is discovered, not assumed, so an older
  Velero without the data-mover kinds (`v2alpha1`), or a cluster with no Velero, is reported
  honestly. "Not found" means absent; any other discovery failure keeps what is already watched
  and is logged, because treating an outage as "Velero has nothing" would empty the inventory.
  Detection reruns on every resync, so installing or upgrading Velero later is picked up.
- **One invariant.** A delta is sent only while a **completed** snapshot exists, and every doubt is
  answered with a new snapshot rather than a patch: a refused send, more than 5 000 unsent
  changes, a new connection, a `RequestResync`, or the 10-minute timer. Missed events therefore
  heal on their own, and the server never has to merge across a gap.
- **No buffering while disconnected.** §5.6 asks for a 5 000-event buffer that overflows into a
  forced resync. The informer caches already hold the truth and a snapshot on reconnect covers
  everything that happened, so nothing is buffered and nothing can overflow. Stronger than the plan,
  not weaker. Pending changes are also discarded when the connection state changes.
- **Snapshots** are chunked to 1 MB with a contiguous 0-based sequence, a snapshot id and `last` on
  the final chunk; an empty cluster sends one empty last chunk so the server replaces its copy with
  nothing. Chunks use a blocking send (`SendWait`): a snapshot is only useful whole, so it waits for
  queue room instead of dropping a chunk. Deltas use the non-blocking send, because refusal has a
  remedy (resync).
- **Deltas** are debounced: the first pending change starts a 2 s clock, a burst becomes one message,
  at most 500 events per batch, `batch_sequence` increasing, each naming its snapshot. An upsert
  whose resource version the snapshot already carried (the late echo of the informer's initial list)
  is dropped, so existing objects are not sent twice.
- **What leaves the cluster is decided here.** `managedFields` and the last-applied annotation (a
  second full copy of the object, and whatever someone pasted) are stripped; nothing is ever read from
  a Secret and there is no Secret kind in the protocol; an object over 256 KB is skipped and logged,
  never truncated.
- **Stale messages.** At the start of each stream the manager discards inventory messages left in
  its queue by the previous one (a half-sent snapshot would only confuse the server), keeping acks and
  results, which are still owed.
- **Config.** `VFM_RESYNC_INTERVAL` (default 10 m, minimum 10 s).

### Verified

Informer-backed tests against a fake Velero (dynamic fake plus fake discovery): snapshot
contiguity and `last`, the empty cluster, chunking under a small limit with every item exactly
once, deltas naming the snapshot, debounce, batch maximum, nothing sent while disconnected and a
complete replacement snapshot on reconnect, server-requested and periodic resync, refused-send and
overflow fallbacks, unserved kinds ignored even when their objects exist, a later Velero install
picked up, and no delta while a snapshot is still in flight. Two mutations (refused batch not
resyncing; chunk limit ignored) each failed their test. A third (deltas before a snapshot) did not,
because the guard is redundant while the single `Run` goroutine is blocked inside the snapshot; the
test pins the property regardless. End to end over the real stream: snapshot on connect, a delta,
and after the control plane is killed and restarted a new snapshot containing everything.

### Not done here

The server does not ingest any of this yet (day 17). It accepts and ignores snapshot and event
messages, which a test proves does not disturb the stream. Nothing has run against a real Velero
or a real API server (B-2).

---

## ADR-022 — Inventory ingest and the event stream (M3 day 17)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

**`velero_resources`** follows §9: org and cluster, kind, namespace, name, uid, resource version,
`phase`, `spec`/`status`/`labels` JSON, `created_by_vfm`, soft delete (`deleted_at`), unique on
`(cluster_id, kind, namespace, name)`. Three timestamps (`started_at`, `completed_at`, `expires_at`) are
extracted into columns, indexed with `(cluster_id, kind, phase)`, so lists can filter and sort without
scanning JSON. Clusters gain `inventory_snapshot_id` and `inventory_synced_at`.

**The ingest contract**

- A snapshot is **assembled in memory per cluster and applied in one transaction** when its last chunk
  arrives; readers see the old inventory or the new one, never half of either. A snapshot cut off by a
  disconnect is discarded with the stream's state. A snapshot beginning while another is arriving
  supersedes it.
- Only **what changed** is written at a routine resync (compared by resource version, uid and deleted
  state); absent objects are soft-deleted and a recreated object takes its row back.
- A **delta** is accepted only against the snapshot currently applied and only in sequence. An unknown
  snapshot, a gap, an out-of-order chunk or an oversize batch is not patched around: it is refused, the agent
  is sent `RequestResync` (rate limited to one per 5 s), and after a gap deltas are ignored until a new snapshot.
  A replayed batch is ignored. A delete applies only if the uid matches, so a stale delete cannot remove an
  object recreated under the same name.
- Per-cluster ingest state is keyed by the **authenticated stream**: an agent cannot write another cluster's
  inventory, and a stream that was refused at Hello is never heard.

**Validation (the agent is semi-trusted, §12)**

- Only the eleven Velero kinds are accepted; the core kinds in the protocol enum wait for M5.
- The identity an item claims (kind, namespace, name, uid) must **equal the object it carries**, so an agent
  cannot file one object under another's name. Names, namespaces and uids must be well-formed; objects over
  256 KB, non-JSON, or without metadata are refused.
- Nothing is stored as sent: strings are bounded and stripped of control characters, labels capped at 64,
  timestamps parsed or dropped (implausible years are dropped). One bad item is skipped and counted; the rest of
  its snapshot is applied. Limits: 50 000 objects and 128 MB per snapshot (above that the snapshot is discarded
  and logged, not retried: asking again would repeat it).

**Events (`/api/v1/stream`, SSE)**

- Events are **thin**: they say a kind changed on a cluster (or a cluster's status, or a command's status),
  never which object or what it holds. The browser re-reads through the REST API, which applies the full
  rules, so exactly one place decides what a user may see, and the stream cannot be a channel for learning
  names.
- Every event is checked against the **receiving user's** permissions (`cluster:read`, or the kind's read
  permission) before it is written, and against the user's active organization. A doubt (a failed check)
  denies. Decisions are cached per connection for 10 s: that is the bound on how long a revoked grant keeps
  delivering, stated rather than hidden.
- Sessions only (an API token has no business holding a browser stream). At most 10 streams per user (`429`
  beyond). The stream ends when its session does (checked every minute with a read that does **not** extend the
  session: an open tab must not defeat the idle timeout). `X-Accel-Buffering: no` and a ping every 25 s keep
  proxies honest.
- Events travel through Redis pub/sub, so a change handled by one replica reaches the streams held by another.
  Events are published for cluster status (connect, disconnect, sweeper), inventory and command progress.
- Written with the Express response directly rather than RxJS `@Sse`, to avoid a new dependency.

**Read model:** `GET .../inventory` returns counts by kind and phase and when the cluster last synced. A kind
the caller may not read is **absent, not zero**; zero would itself be information. API-token limits apply (a
bug the test caught: the first version ignored the token and listed every kind).

### Verified

Ingest: 20 e2e tests over real gRPC/mTLS and PostgreSQL (multi-chunk and empty snapshots, atomic swap with the
old inventory visible until the last chunk, discard on disconnect, out-of-sequence, supersession, revival,
only-what-changed, delta ordering/replay/unknown snapshot/gap/stale delete, forged identity and unsupported
kinds while good items are applied, cross-cluster isolation, a refused stream is not heard, counts, token
narrowing, 404, cascade) plus 21 validation unit tests. Events: 11 e2e tests over real HTTP with two replicas
(statuses and inventory, no names in events, delivery across replicas, per-user visibility and the moment a
grant arrives, revocation within the window, org isolation, auth, the stream cap, session end); three mutations
(no permission check; other orgs' events; no kind filter) each failed a test. Live: the real Go agent's syncer
fed the real server: a snapshot, a create, an update and a delete landed, and a last-applied annotation containing
a secret was never stored.

### Not verified / honest limits

Per-kind filtering cannot yet differ for a browser session: every built-in role grants all five read
permissions together, so it is exercised only through API-token limits. Nothing ran against a real Velero. The
SSE has not been driven by a browser (no UI consumes it until day 18).

---

## ADR-023 — Fleet and cluster overview (M3 day 18)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decision

**Server**

- `GET /orgs/{orgId}/fleet` returns every cluster the caller can see with its backup, schedule and
  storage health; `GET /orgs/{orgId}/clusters/{id}/overview` returns one cluster's health, inventory
  counts, storage locations and recent backups and restores.
- **Permissions are evaluated in bulk.** `RbacService.matrix()` answers "which of these permissions does
  this user hold on each of these clusters" in four queries however many clusters there are, using the same
  pure engine as every other check, so the two cannot disagree. The fleet page would otherwise have cost
  hundreds of round trips; the existing cluster list now uses it too (its e2e tests pass unchanged).
- **A section the caller may not read is `null`, never zero.** A zero would itself tell a restricted user
  something. The client in turn never sums across a cluster it cannot fully read: a total that would include
  an unreadable cluster is shown as "—", not as a partial number presented as the whole.
- The latest finished backup per cluster is found with one grouped maximum and one lookup of those rows,
  rather than by loading every backup.

**Web**

- **Fleet overview** (`/`): totals, a "needs attention" list, and a table of clusters with last backup,
  schedules and storage health. **Cluster overview** (`/clusters/:id`): health, versions with plugins, the
  agent's policy, storage locations with their state and message, recent backups and restores, an inventory
  empty state, and a Refresh button that is disabled, with the reason, when the agent is not connected.
- **"Needs attention" is a pure function with a table test per rule** (`lib/fleet.ts`): disconnected,
  enrolled-but-never-connected, pending, unavailable storage, a failed or partially failed last backup, invalid
  schedules, stale inventory, an outdated agent. A disabled cluster is never flagged; a `null` section produces
  nothing; ordering is errors, warnings, notes, then by name, with stable keys.
- **Live updates use the stream only as a nudge.** Events carry no data (ADR-022); on one, the fleet and
  cluster queries of that organization are re-read through the REST API, debounced to 300 ms, and also on every
  (re)connect, because whatever changed while the stream was down is found only by looking. A browser that has
  given up on the stream (an HTTP error) is reconnected by hand with backoff; while the stream is not live the
  pages poll every 15 s, and every 2 min when it is (a safety net, not the mechanism). A "Live / Reconnecting /
  Updates paused" indicator is always in the header so nobody trusts a screen that has stopped updating.
- Tabs that do not exist yet (Backups, Restores, Schedules, Storage, Workloads, Events, Activity, Access) are
  **visible but disabled with the reason** (PLAN §11.2); none is a mock-up. Times show in the viewer's timezone
  with the UTC instant on hover.

### Verified

Server: 9 e2e tests over real gRPC and PostgreSQL (health summaries, a never-reported cluster, per-cluster
isolation, visibility with and without a binding, organization isolation, `null` sections under narrowed API
tokens, the overview's storage-location parsing and recent activity, 404s). Web: 42 unit tests (every attention
rule, totals including the partial-sum refusal, phase tones, relative time, durations), 8 for the stream with a
fake `EventSource` (debounce, org-scoped invalidation, reconnect with growing delay, backoff reset, no effect
after close, no `EventSource`), and 13 page tests. **Driven for real in Chrome** against a real server and the
real Go agent code feeding a changing fake cluster: the fleet page updated with no reload (the Velero version
appeared from the server's on-connect refresh; the backup count rose, a partially-failed then failed last backup, an
unavailable storage location and an invalid schedule each appeared as attention items), the "Live" indicator showed, the
cluster page rendered every section, and the agent's exit surfaced as "disconnected" on its own.

### Found along the way

An unrelated crypto unit test from M1 built a `RegExp` from random base64, which fails to compile when the
string starts with `+` or `/`, so it failed a few percent of the time. It now compares plain substrings (40 clean
runs). A stray `prettier --write` run from `server/` kept reformatting the generated protobuf stubs; they were
restored each time and are covered by `.prettierignore` only from the repository root.

### Not verified

The pages at narrow widths and by keyboard only (I did not drive them); real Velero data; the stream through a
buffering proxy (the server sets `X-Accel-Buffering: no`, untested behind one).

---

## ADR-024 — Lists, detail pages and who may see which backup (M3 day 19)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decisions

- **Namespace visibility (PLAN §8.2).** A binding scoped to namespaces sees a backup, restore or schedule only if
  _every_ namespace it covers is in scope and it does not include cluster-scoped resources. An empty or `*` namespace
  list needs a whole-cluster binding; exclude lists never narrow coverage; restores count both their source and
  mapped-target namespaces; schedules use `spec.template`. "Includes cluster resources" counts only when explicitly
  `true` or `includedClusterScopedResources` is non-empty (Velero's unset/"auto" does not). That is deliberately
  looser than the _create_ rule, which M4 must make strict (explicit `false` required). Storage objects are
  cluster-level and are not namespace-filtered.
- **404 for hidden and missing alike.** A detail request for an object the caller may not see answers exactly as for
  one that does not exist (bodies differ only in `instance`/`requestId`), so names cannot be probed.
- **Pagination.** Opaque cursor `base64url({id, s})`, where `s` signs kind+sort+order+filters, so a cursor replayed
  with a different query is rejected. Page size default 50, max 200. Unscoped callers fetch `limit+1` for an exact
  "more"; callers with narrowed visibility scan in batches (at most 2000 rows) so sparse pages still fill.
  `paused=false` is decided in that scan, since SQL cannot match a missing JSON key. Unsupported sort/filter is 400,
  a malformed query 422.
- **Detail** returns summary, timeline, labels, spec, status, YAML and the related PodVolumeBackups/DataUploads
  (label `velero.io/backup-name`).

### Deferred

Next-run times for schedules (needs a cron library; belongs to the M4 wizard). Restore action on the backup page is
visible but disabled with its reason until M4.

### Verified

21 projection unit tests; 23 e2e tests over real PostgreSQL and gRPC; 13 web tests. Mutation checks: list ignoring
visibility (5 tests failed), detail ignoring visibility (2), cursor not bound to its query (1). A fourth (exclude
lists narrowing) is equivalent at e2e level and is covered by a projection unit test.

### Not verified

Real Velero data (B-2); narrow viewports and keyboard-only use; the pages were not driven in a browser this
session (covered by web unit tests and server e2e only).

---

## ADR-025 — Velero's per-backup files through `FetchDownload` (M3 day 20)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decisions

- **Agent.** `velero.DownloadHandler` creates a `DownloadRequest` (labelled with the command id, so a retry reuses
  it), waits for `Processed`, fetches the signed URL **from inside the cluster**, gunzips and streams the bytes as
  64 KiB `LogChunk`s keyed by command id, ending with an empty `eof` chunk, then answers with the byte count and
  SHA-256. It removes the request on every path. `BackupContents` is not in the table of fetchable kinds (never
  proxied, P2); names are checked as Kubernetes names; the size limit (default 16 MiB, hard 64 MiB) also stops a
  compression bomb; a full outbound queue slows the download instead of dropping a chunk; the signed URL never
  appears in an error or a log. A download is allowed in read-only mode (it creates only a transient request).
- **Server.** `DownloadAssembler` rebuilds the file in memory on the replica that holds the agent's stream. Limits:
  64 KiB per chunk, the command's size, four downloads per cluster, 256 MiB per replica, two minutes idle. The first
  chunk is the point where the command is checked to be this cluster's running `FETCH_DOWNLOAD`. A gap, a repeat,
  data after the end, a different size or a wrong checksum fails the command and stores nothing.
- **Cache.** `velero_files` in PostgreSQL, gzipped, keyed by cluster + part + target name + **target uid** (a
  recreated backup never shows the old file). A finished object's copy lives `DOWNLOAD_CACHE_TTL_DAYS` (default 7;
  0 switches caching off); one still running keeps its copy 30 seconds. Expired rows are purged every 10 minutes.
- **API.** `POST …/{backups|restores}/{name}/logs` and `…/details/{part}` ask for a fetch (202 with the command, or
  200 when a fresh copy is held; `?refresh=true` forces one; a second request joins the one in progress);
  `GET` serves the held copy as `text/plain` (`nosniff`, `no-store`, 204 when none; `?download=1` attaches it).
  Logs need `backup:logs` / `restore:logs`, the detail parts the kind's `read`; a hidden object answers 404 exactly
  like a missing one (ADR-024). A POST is audited by the existing middleware.
- **UI.** Each file is a panel that reads nothing until asked: not fetched, fetching (follows the command, also in a
  background tab), failed with the agent's reason and _Try again_, ready with fetched/kept-until times, _Refresh_,
  _Download_. The log view filters by level and text and shows 500 lines at a time; resource lists group by kind;
  everything is shown as text, never as markup.

### Deferred

Reading a file is not audited (only the POST that fetches it); a per-file rate limit beyond "one fetch at a time";
`BackupContents` download links (M4, `backup:download`); virtualised log rendering for very large logs (M5).

### Verified

13 assembler unit tests; 16 Go handler tests (chunk order and checksum, exact chunk multiples, plain-text
passthrough, limit and compression bomb, refused kinds and names, signed URL never leaked, only http(s), cleanup,
retry reuse, back-pressure, cancellation); 23 server e2e tests over a real gRPC stream and PostgreSQL (mutation checks:
checksum check removed, visibility removed, command-ownership check removed all fail tests); 10 web tests. The real Go
handler was run against the real server once (a 6 000-line log through many chunks, intact), and the pages were driven in
Chrome: fetch, background polling, saved copy after reload, level filter, resource list and results panels.

### Not verified

A real Velero `DownloadRequest` and real object storage (B-2); logs near the 16 MiB limit in a browser; narrow
viewports and keyboard-only use.

---

## ADR-026 — Backup create, delete and run-now (M4 day 21)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decisions

- **API.** `POST …/backups` (every `velero backup create` flag as a typed, **strict** field — an unknown field is
  a 422), `DELETE …/backups/{name}` (sudo mode, session only, never an API token) and
  `POST …/schedules/{name}/trigger`. Each answers 202 with the command; a backup is never reported as made by the
  response. `--wait` is the UI following the command and the inventory.
- **Namespace rule for creating (PLAN §8.2), one pure function `createCoverage`.** Empty or `*` namespaces mean all;
  exclude lists and selectors never narrow; the backup includes cluster-scoped resources **unless
  `includeClusterResources` is explicitly `false`**, and any named cluster-scoped kind counts whatever that says. So a
  scoped user must name every namespace and send `false`. This is deliberately stricter than the read-visibility rule
  of ADR-024 ("auto" does not hide a backup, but does stop one being made). Namespace names are DNS labels or `*`;
  globs such as `dev*` (which Velero 1.18 expands) are refused so a pattern cannot step outside a scope.
- **Escape hatch.** `advancedSpec` needs `advanced:write` on the whole cluster, and so do hooks (they run commands in
  workloads), which are not a typed field. It is merged onto the generated spec by the agent and the result checked
  against Velero's `BackupSpec` shape (a table in `agent/internal/velero/backupspec.go`; unknown fields, wrong types,
  bad durations rejected with their paths). The agent does not link Velero's Go types, so the table is the contract
  and is held by tests; a schedule's template, already accepted by Velero, is copied as it is.
- **Delete** creates a `DeleteBackupRequest` (labelled with the backup's name and uid, as the CLI does), never deletes
  the `Backup`: that would leave its data in object storage. A hidden backup answers 404 like a missing one; a scoped
  administrator can delete only what their scope covers (`backup:delete` visibility).
- **Trigger** checks schedule visibility (404 if hidden), then `backup:create` over what the template covers (403).
- **Idempotency** as for every command: the agent finds an object by the `vfm.io/command-id` label before creating.
  Names are checked to be at most 63 characters, because Velero turns them into label values.
- **Known leak, accepted.** Choosing a name that is already taken reports ALREADY_EXISTS in the command, which tells a
  scoped user a backup of that name exists even if it covers other namespaces. The wizard generates names.

### Deferred

Object labels/annotations beyond `spec.metadata.labels` (`--labels`); restore, schedule and storage writes (days
23–27); the wizard and CLI-equivalent generator (day 22); a pre-check of storage-location names against inventory.

### Verified

18 Go handler tests, 40 server unit tests (the coverage rule exhaustively, strictness, durations, protobuf), 36 e2e
tests over a real gRPC stream and PostgreSQL. Mutation checks failed tests when removed: the cluster-scoped rule, the
`advanced:write` check, the delete visibility check, the trigger authorization, and the strict unknown-field check.
The real Go handlers were run against the real server: a backup with selectors, durations, an optional `false` and a
hook arrived as intended; an unknown advanced field was refused with its path; a schedule produced a backup from its
template; a delete created a request and left the backup object.

### Not verified

Real Velero (B-2): that Velero accepts every generated spec and that `DeleteBackupRequest` behaves as the CLI's does.
No browser UI exists for this yet.

---

## ADR-027 — The backup wizard, confirmations and notifications (M4 day 22)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decisions

- **Four steps, one live preview.** What to back up → storage and volumes → options → review. The equivalent
  `velero backup create …` command is on screen on every step and updates as the form changes, with a copy button
  that says so when the browser refuses to copy. Fields with no CLI flag (advanced settings) are listed as notes
  rather than given an invented flag. The review shows the exact request body.
- **Pure form library.** `lib/backup-form.ts` holds the validation, the API body and the command generator, with
  49 tests. Validation mirrors the server's rules and says what is wrong next to the field; the server stays the
  authority. Label selectors are read the way `kubectl -l` reads them, including set expressions.
- **What the user may do is asked, not guessed.** `GET …/clusters/{id}/access` answers `cluster`, `scoped` or `none`
  for the write permissions; a cluster-level permission (`advanced:write`, `storage:write`) is never `scoped`. It is a
  hint for disabling controls with a reason; every request is still authorized by itself. A user limited to some
  namespaces starts with cluster-scoped resources set to "No" (the only setting the server accepts for them), must name
  each namespace, and cannot use the advanced field.
- **Typed confirmation, then sudo.** `ConfirmDelete` needs the exact name typed before its button works, closes on
  Escape and focuses the input. The request then goes through `api()`, which opens the password dialog if the server
  asks for a recent sign-in and repeats the request. The `destructive` button variant exists only behind that dialog.
- **Notifications follow commands.** `ToastProvider` (in the app shell, so it survives navigation) follows a command
  until it ends, also in a background tab; success disappears after ten seconds with a link to what was made, failure
  stays with the agent's reason until dismissed. A 202 is never shown as success.
- **Entry points.** _Create backup_ on the backups list, _Delete backup_ on the backup page, _Run now_ on each
  schedule; each is disabled with its reason when the user lacks the permission.

### Deferred

A restore button on the backup page (day 24); the CLI preview on the schedule and restore forms (days 24–26);
choosing namespaces from the cluster's list (needs the M5 inventory); the _Activity_ tab for command history.

### Verified

49 form-library tests, 20 wizard/dialog/toast page tests and one server test for `access` (mutation checks failed
tests when the typed-name check, the limited-user rule and the limited-user wiring were removed). Driven in Chrome
against a real server and the real Go handlers over mTLS gRPC: the wizard produced the shown command and request,
the backup was created and the notification linked to it; a delete needed the typed name and, with an aged session,
the real password dialog, then succeeded; _Run now_ created a backup from the schedule's template.

### Not verified

Real Velero (B-2). Narrow viewports and keyboard-only use beyond what the tests do (focus on the dialog input and
Escape). A user limited to some namespaces was exercised in tests, not in the browser.

---

## ADR-028 — Restore create and delete (M4 day 23)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decisions

- **API.** `POST …/restores` (every `velero restore create` flag as a typed, strict field; exactly one of `backupName`
  and `scheduleName`) and `DELETE …/restores/{name}`. Both need a recent re-authentication (PLAN §8.3) and therefore a
  session: an API token is refused, as for a backup delete. Each answers 202 with the command.
- **Authorization covers what is read and what is written (PLAN §8.2).** `restoreCoverage` counts the included
  namespaces and, through `restoreNamespaces`, **both sides** of every mapping; empty or `*` means all; the restore
  includes cluster-scoped resources unless `includeClusterResources` is explicitly `false` (the rule for backups).
  A user scoped to `dev` can therefore neither restore into `prod` nor restore `prod`'s data into `dev`. Mapping
  names are DNS labels, never `*` or a glob.
- **Escape hatch and hooks.** As for backups: `advancedSpec` needs `advanced:write` on the whole cluster. Restore hooks
  (exec commands, init containers) are reachable only that way. The agent validates the merged spec against a table of
  Velero's `RestoreSpec` (hooks included; embedded containers are passed through for Kubernetes to judge).
- **The agent's policy is applied to the spec that will really be created.** The dispatcher judges the typed command
  before the handler runs, but the advanced settings are merged on afterwards and can name any namespace. The handler
  therefore calls `Policy.CheckRestoreScope` on the merged namespaces and mapping and refuses a protected one
  (`FORBIDDEN_BY_AGENT_POLICY`); a handler without a policy refuses to restore. This is the control the cluster owner
  holds that the control plane cannot change (PLAN §5.5); a test fails if the check is moved back to the typed spec.
- **Source must exist.** The agent looks up the backup or schedule and answers `NOT_FOUND` rather than create a
  restore that fails validation. The server does not check, so it neither needs nor leaks inventory visibility of the
  source; a scoped user restoring one namespace out of a backup they cannot see is the common case. Naming a backup
  reveals only whether that name exists (same accepted class as ADR-026).
- **Delete** removes the `Restore` object (what the CLI does); restored resources stay. A scoped administrator can
  delete a restore only if every namespace it read or wrote (mapping included) is in scope, otherwise 404 like a missing
  one. Deleting twice answers `NOT_FOUND` the second time; a crash between the delete and its result can show a
  succeeded delete as `NOT_FOUND` after the retry. Accepted: the object is gone either way.
- **UI.** Only the notification layer changed: a created restore links to its page and a deleted one is explained. The
  restore wizard is day 24.

### Deferred

The restore wizard and impact summary (day 24); approval before a restore (M6, `requireRestoreApproval`); a check that
the source backup is `Completed` before restoring.

### Verified

11 Go handler tests (every flag, exactly one source, the policy applied to the advanced spec, no policy no restore,
strict advanced restore spec including real hook shapes, retry reuse, name limits, delete), 29 server unit and 30 e2e
tests (mutation checks failed tests when removed: the mapping targets, the cluster-scoped rule, sudo, the delete
visibility check and the `advanced:write` check). The real Go handlers ran against the real server: a restore with
mapping, policy and timeouts arrived as intended; a protected target was refused both through the typed fields and
through the advanced settings; a missing source was `NOT_FOUND`; a delete left the other objects alone.

### Not verified

Real Velero (B-2): that it accepts every generated spec. No UI for creating a restore yet.

---

## ADR-029 — The restore wizard and the namespace check (M4 day 24)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decisions

- **Four steps, the same shape as the backup wizard.** Source (a backup or a schedule's latest; opened from a backup
  page it arrives chosen) → scope (namespaces, `source:target` mapping, resources, selectors, cluster-scoped) → options
  (existing-resource policy, volumes, node ports, status, timeouts, modifier, downloads, advanced) → review. The
  equivalent `velero restore create …` command is on screen throughout. The pure `lib/restore-form.ts` holds the
  validation, body, command and impact logic (35 tests); fields shared with the backup wizard moved to
  `components/form-fields.tsx`.
- **The impact summary needs a new, additive protocol command: `CheckNamespaces`** (proto field 26; result
  `NamespaceReport`). The plan wants "which target namespaces exist now", the namespace inventory belongs to M5, and
  listing every namespace to a user limited to some of them would disclose names. The command takes **the names the
  wizard is about to write into**, the agent reads each with a single `get` (never a list; at most 100) and answers for
  those names alone; the server first requires `restore:create` over every name asked about, so the check cannot be
  used to learn whether another namespace exists. Allowed in read-only mode (it changes nothing). The result is kept in
  the command row, bounded to 100 entries, with names length-capped.
- **What the summary says** per target: _new_ (will be created), _exists_ (resources already there are left as they are
  and missing ones added; with `update`, existing ones are changed to match), _being deleted_ (the restore would fail:
  the button is disabled until it is gone), or _unknown_ (not yet answered, or the cluster could not be asked — the
  restore may still go ahead, and _Check again_ is offered). A restore of **all** namespaces cannot list targets in
  advance and says so rather than guess.
- **Sudo.** The wizard asks for nothing itself; the request goes through `api()`, which opens the password dialog when
  the server demands a recent sign-in. The review step says that may happen.
- **Entry points.** _Restore from this backup_ (enabled for a completed or partially failed backup, disabled with the
  reason otherwise or without `restore:create`) and _Restore_ on the restores list. The notification links to the new
  restore.
- **Test determinism.** Page tests wait up to four seconds (`asyncUtilTimeout`) instead of one: with the suite at 250
  tests running in parallel a cold full-page render sometimes took just over a second, which made two tests flaky.

### Deferred

A "latest backup of this schedule" shortcut on the schedules list; a diff of what the restore would change inside an
existing namespace (needs resource-level inventory, M5); approval before a restore (M6); the Activity tab.

### Verified

8 Go tests for the namespace check (only single reads, only the names asked, bounded, bad names refused), 35 form-library
tests, 13 wizard and entry-point page tests, 9 server e2e tests (the asked names only, bounded answers, scoped users
limited to their own namespaces, mutation check: removing the authorization made a test fail). Driven in Chrome against
a real server and the real Go handlers: opened from a backup page the source was chosen; the impact table showed an
existing, a new (renamed) and a being-deleted namespace as the cluster reports them and disabled the button for the
last; after removing it the restore was created with the mapping and the notification linked to it.

### Not verified

Real Velero and a real API server (B-2). Narrow viewports and keyboard-only use. A namespace-limited user in the
browser (tests only). The sudo prompt in this flow (shown for backup delete; the same `api()` path).

## ADR-030 — Schedules (M4 day 25)

- **Date:** 2026-10-16
- **Status:** Accepted

### Decisions

- **A schedule is authorized as the backups it will make.** `schedule:write` is required over everything the template
  covers, by the same strict rule as a backup (`createCoverage`: namespaces named, `includeClusterResources: false`).
  Changing an existing schedule also needs its **current** template in reach, so a scoped user cannot take over a wider
  schedule by narrowing it; a schedule they cannot see is a 404. Pause/resume need `schedule:write`; delete needs
  `schedule:delete` and a recent sign-in, and is closed to API tokens. `advancedSpec` (merged onto the template) needs
  `advanced:write` on the whole cluster. `trigger` and the schedule rule share `templateCoverage`.
- **Name ≤ 48 characters.** Its backups are `<name>-<14-digit stamp>`, which must fit a 63-character label.
- **Cron is checked in three places and Velero stays the authority.** The server and the agent refuse an expression
  Velero (robfig/cron's standard parser) would not read: five fields, `@yearly`-style descriptors, `@every <duration>`;
  the web has its own parser for the preview. Hand-written rather than a dependency: the grammar is small and
  `cron-parser` publishes new releases every few weeks. Velero reads the expression in its process's time zone,
  normally UTC: the builder's hour is a UTC hour, and runs are listed in UTC and the viewer's own zone.
- **Update replaces the spec, but keeps hooks.** The form cannot express hooks (they need `advanced:write`), so an
  update that does not mention them leaves the template's hooks as they are rather than silently dropping what an
  administrator set; sending `advancedSpec.hooks` replaces them. Other template settings the form has no input for
  (metadata labels, the volume-group label key) are carried through by the edit form. Removing hooks therefore needs
  `advancedSpec` or deleting the schedule.
- **Detail endpoint.** `GET …/schedules/{name}` (same visibility as the list) feeds the edit form.
- **One set of fields.** The backup spec fields live in `components/backup-fields.tsx` and serve both wizards.

### Deferred

"Restore latest" from a schedule; a schedule's own detail page; last-run status beyond the list; time-zone-aware
`@every` previews (Velero counts from its own last run).

### Verified

Go: create, idempotent re-delivery, refused specs, advanced onto the template, update keeps identity and hooks, pause
touches only `paused`, delete leaves backups, cron grammar. Server: 31 unit tests, 28 e2e tests (mutation check:
removing the current-template authorization made a test fail). Web: cron parser and builder, form library (round trip
of a stored spec), wizard create/edit and list actions. Driven in Chrome against the real server and Go handlers.

## ADR-031 — Storage locations and credentials (M4 day 26)

### Decisions

- **The credential is held in memory, not stored.** A request may carry credential text (`credential.content`). It
  goes into the command as a `CredentialSecret` and nowhere else: the `commands` row keeps a payload with only the
  Secret's name and key and `rotatesSecret: true`; the text is kept in `CommandsService.transients` (a map in process
  memory) until the command finishes, is cancelled, fails, or its deadline passes (swept every 10 s). Neither the
  audit entry (field names only, ADR-013) nor any response nor any log carries it. If the command must be sent again
  after a restart or from another replica, the text is gone: the command **fails** with "submit the change again"
  rather than sending a location without its credential. While a command is relayed to an agent on another replica the
  message passes through Redis pub/sub (not persisted); accepted.
- **Two ways to give a credential.** Text (`content`; Secret name defaults to `vfm-bsl-<name>` / `vfm-vsl-<name>`, key
  to `cloud`), or a reference to a Secret that exists (`secretName` + `key`, no secret material). An update that leaves
  `credential` out keeps the Secret the location uses now.
- **The agent never touches a Secret it did not write.** It creates the Secret with `vfm.io/managed` and
  `vfm.io/location: <Kind>/<name>`; it updates or deletes a Secret only when both annotations match that location. A
  credential aimed at `cloud-credentials` (Velero's own) is refused with `ALREADY_EXISTS`. Deleting a location empties
  the Secret it wrote (the credential is gone from the cluster) but leaves the empty Secret: PLAN §12.2 gives the
  agent no `delete` on Secrets and the chart test pins that. A later location of the same name reuses it.
- **Provider settings must not hold secrets.** `config` is stored and shown as it is, so a key that looks like a
  secret (password, secret, token, accesskey, privatekey, credential) is refused in the server, the form and the tests;
  `signatureVersion`-style keys are fine.
- **Authorization.** All writes need `storage:write` over the whole cluster (a namespace-limited user is refused);
  delete also needs a recent sign-in and refuses API tokens; the other writes are open to tokens. There is no separate
  `storage:delete` permission (PLAN §8.2 has none).
- **One default.** Setting a default (or saving a location as default) clears the flag on the others. The server
  refuses to delete the default location while others exist (409). Creating a name that exists is 409, changing or
  deleting one that does not is 404 (by the inventory; the agent is idempotent either way).
- **Update replaces the spec** (so what the form shows is what Velero gets); `default` is carried over when the
  request does not say.
- **Availability** is the existing state column (phase, message, last validated) on the Storage page, fed by the
  inventory.
- **Detail endpoints** `GET …/backup-locations/{name}` and `…/snapshot-locations/{name}` feed the edit form (spec
  holds only the credential reference).
- **Web form.** One page for backup and snapshot locations (`/clusters/$id/storage/{backup,snapshot}-locations/new` and
  `…/$name/edit`), masked credential box with "show", file load, no draft storage, request built inside the mutation
  function so react-query never holds the text, CLI preview without it.

### Deferred

`caCertRef` (reference to a CA in a Secret); a credential-less "none" choice when editing; showing which backups use a
location before deleting it; BSL access-mode change guard; the grep test across _all_ logs and dumps (day 27).

### Verified

Go: Secret written and referenced, update and rotation, foreign Secret never overwritten, one default, delete removes
only our Secret, VSL, refusals, no result carries the text. Server: 22 unit, 39 e2e (mutation check: storing the text
in the payload made the all-tables scan fail). Web: form library and page tests. Driven in Chrome against the real
server and the real Go handlers (fake Kubernetes): create with a credential, make default, edit with rotation, typed
delete; the test credential was found only in the Secret (database scan of every table, both logs, Velero object).

## ADR-032 — The write-ops sweep and the agent policy in the UI (M4 day 27)

### Decisions

- **Golden paths are tested at the control plane with a scripted agent.** `golden-paths.e2e.test.ts` drives paths 2–7
  and 10 through the real API, command pipeline and gateway; the "cluster" acknowledges, reports success and reports
  objects as the agent's informers do. What it cannot show is Velero doing the work; those halves stay 🟡 until a real
  cluster exists (B-2) and the human checkpoint.
- **The agent's policy reaches the UI.** `GET …/access` now folds the cluster's reported agent policy into the answer:
  `readOnly` makes every change `none` (reading logs stays), `allowRestore: false` removes `restore:create`,
  `allowBslWrite: false` removes `storage:write`; `blocked` carries the reason per permission and the web shows it as the
  disabled action's explanation (`useAccess().why`). The server still forwards a request made anyway; the agent refuses
  it and the refusal is the command's outcome (PLAN §5.5). Before this the UI only showed a read-only badge.
- **Log capture seam.** `logDestination` in `app.module.ts` lets a test read every log line (debug level, with service
  logs routed through pino as `main.ts` does). Production never sets it. The credentials test scans those lines, every
  table of the database, every API read afterwards and the audit log; a Go test does the same for the agent's
  dispatcher logs and messages to the control plane. Mutation check: logging the credential in the service failed it.

### Deferred

Golden paths 1, 8, 9, 11 (M2 days) and 12 (M6); the paths' real-cluster halves; Playwright (plan §15) against kind.

### Verified

Server unit 791, e2e 466 (7 new); web 357; Go all packages (1 new); access policy unit tests; lint, typecheck, build.

## ADR-033 — The core inventory (M5 day 28)

### Decisions

- **A projection, not a redaction.** For Node, Namespace, Pod, PVC and Event the agent builds a _new_ object holding only
  allowlisted fields (`agent/internal/inventory/core.go`); nothing is deleted from the real object to get there, so a
  field nobody listed cannot leak by being forgotten. A pod keeps phase, ready/restart counts, node, owner and per-
  container `{name, image, state, reason, restarts, lastTerminationReason}`; no env vars, commands, volumes, annotations,
  labels or container messages (they routinely carry secrets). Nodes keep conditions (type, status, reason; no message),
  allocatable, kubelet version, taints, schedulable; PVCs keep class, volume, phase, capacity. Events keep type, reason,
  message (512 characters), count, involved object. The server bounds everything again on read.
- **Stored in `velero_resources`, not a second table.** PLAN §9's `cluster_inventory` is that table's role for the core
  kinds: one atomic snapshot, one delta path, one org-scoping extension. Kind names are `NODE`, `NAMESPACE`, `POD`,
  `PERSISTENT_VOLUME_CLAIM`, `EVENT`. Cluster-scoped kinds must arrive with no namespace; namespaced ones with a valid one.
  Synthetic `status.phase` (node Ready/NotReady, event Warning/Normal) and `status.startTimestamp` (pod start, event last
  seen) let the generic columns serve list filters and sorts.
- **Cluster-wide watch, Velero-namespace watch kept.** A second informer factory watches the core kinds in every namespace;
  Velero's kinds stay in Velero's. `VFM_CORE_INVENTORY` (default on) switches the live view off.
- **Events.** Kept if a warning or about a `velero.io` object, and only for an hour: an event that stops qualifying is
  retired with one DELETE (tracked in a `reported` set so it is sent once); the list also filters by the hour, covering the
  gap until the agent or Kubernetes drops it. The plan's daily retention job is therefore not needed for events.
- **Pod scope (`WatchScope`).** Past `VFM_POD_SCOPE_THRESHOLD` pods (default 20 000, switching back at 90 %) the agent reports
  pods only for namespaces named by a new `WatchScope` server message, and nothing until it is told. The control plane marks a
  namespace wanted for 10 minutes whenever an authorized user lists its pods (a Redis sorted set, shared by replicas),
  sends the whole set when it changes, and does not send "nothing" to a fresh agent (that is its default). A small cluster
  always reports every pod.
- **Reads.** `GET …/inventory/{nodes,namespaces,pods,pvcs,events}` need `cluster:read`; nodes are visible to everyone with
  it, while namespaces, pods, PVCs and events follow the **namespace scope of `backup:read`** (the plan has no separate
  workload permission): a namespace-limited user sees only their namespaces. The per-kind totals of `GET …/inventory`
  leave the live-view kinds out, so a limited user is not told how many pods other namespaces hold.
- **Limits.** The per-cluster snapshot cap stays 50 000 items; 20 000 pods plus the rest fits, and a cluster near it should
  lower the pod threshold.

### Deferred

"Last successful backup covering this namespace" and the tables themselves (day 29); the chart's values for the two new
settings (the defaults apply); pod labels (needed only if the UI filters by them).

### Verified

Go: projections (a pod full of secrets reports none), events, snapshot across namespaces, scope (large cluster, small
cluster), one retirement. Server: kind and namespace rules, summaries, a fixture produced by the agent's own projections
validates, 10 e2e (lists, filters, visibility, refusal of malformed items, scope messages, no count leak). The two tests that
assumed a pod was an unsupported kind now use a truly unsupported one.

## ADR-034 — The workloads UI and namespace backup coverage (M5 day 29)

### Decisions

- **"Last successful backup covering this namespace"** is computed by the control plane when namespaces are listed
  (`inventory/coverage.ts`): from the newest 2 000 `Completed` backups and the enabled schedules, a backup covers a
  namespace if its namespace filter includes it (empty or `*` means all) and does not exclude it. It is judged by the
  namespace filter alone: a backup narrowed by label selectors or resource lists still counts, and the page says
  "covering", not "restorable". `PartiallyFailed` is not "successful".
- **Badges.** `recent` (the backup finished within 48 hours), `stale` (older), `none`; and `scheduled` when an unpaused
  schedule's template covers it. 48 hours is a constant, not a setting.
- **What a limited viewer is told.** The time of the newest covering backup is not a secret about a namespace they can
  see, but a backup's name is given only if they may see that backup (all its namespaces in their scope); otherwise the
  name is null and the page shows the time alone.
- **One Workloads tab with four views** (namespaces, pods, nodes, volume claims) and a separate Events tab, all built on
  the existing `ResourceList` (filters, sort, cursor paging). "Show pods" on a namespace opens the pods filtered to it,
  which is also what asks a large cluster's agent for that namespace's pods. Pod rows expand (native `<details>`) into
  their containers: state, reason, restarts, last termination reason, image.
- **Pod scope is published one at a time per cluster**, so several requests at once send one `WatchScope` message
  instead of several identical ones.
- **The Activity tab** stays disabled; its reason now says plainly that a command history page is not built (it said M4,
  which was wrong).

### Deferred

A per-namespace detail page; coverage by label-selector backups; a setting for the staleness threshold; logs from a pod
row (day 30).

### Verified

Server: 15 coverage unit tests, 4 e2e (times, scheduled, none, a name withheld from a limited viewer), a single scope
message under concurrent requests. Web: 8 page tests. Driven in Chrome against the real server and the real agent
syncer (fake Kubernetes objects, including a pod carrying env vars and annotations): the namespaces table, Show pods,
a pod's containers, the events tab; the agent received the pod scope; no database table, server log or agent log
contains the planted secret.

## ADR-035 — Live log sessions (M5 day 30)

### Context

PLAN §5.6 and §7.2 want a container's log streamed on demand through the agent, shown in the browser, audited at the
start, and stored nowhere. The control plane runs as several replicas, and the replica that holds an agent's stream is not
necessarily the one holding a browser's connection.

### Decisions

- **A session is Redis state plus a channel, never a row.** `vfm:logsess:{id}` holds who asked for what; chunks are
  published on `vfm:logs:{id}` and read by the replica that holds the browser's SSE connection. Nothing is written to
  Postgres, and a grep of every table for a planted log line finds nothing.
- **`POST …/log-sessions` records and audits; it does not start anything.** The agent is asked to start when the first
  stream is opened, after the replica has subscribed, so the first lines are not lost to a subscriber that is not there
  yet. A session nobody opens is forgotten after a minute and the agent is never bothered. Stored nowhere also means no
  replay: lines produced while no stream is open are gone, and the API says so.
- **Checks, in order:** `logs:read` on the pod's namespace (a person who may read `dev` may not read `prod`); the agent's
  own policy as it reported it in `Hello` (`allowLogStreaming`, `logStreamDeniedNamespaces`, with `*`), so the control
  plane says no first with the reason; a connected agent (409 otherwise); a per-person limit (`LOG_SESSIONS_PER_USER`,
  default 5, so one person cannot take the cluster's 10 slots). The agent checks its policy again before reading anything.
- **Browser sessions only.** No route here opts in to API tokens. A session can be seen, stopped and streamed only by the
  person who started it, and any other person, cluster or organization path gets the same 404 as a session that does not
  exist.
- **Revocation reaches a running stream.** Every 30 seconds a stream re-checks the login and the permission and ends with
  `revoked` (and the agent is told to stop) if either is gone.
- **The owner replica watches for idleness.** Whoever took the `POST` ends a session that has had no subscriber for 60
  seconds (subscribers refresh a short-lived key). If that replica dies, the agent's own 30-minute hard timeout is the
  backstop. When an agent disconnects, the replica that held its stream ends every session of that cluster.
- **A chunk is accepted only for the cluster the session belongs to**, is at most 64 KB (larger ends the session), and is
  decoded as UTF-8 with a per-session decoder so a character split across chunks survives and bytes that are not text
  become U+FFFD. A chunk for a session the control plane does not know makes it tell the agent to stop.
- **Agent (`internal/logs`).** `pods/log` with follow, read in chunks of at most 64 KB; at most
  `VFM_MAX_LOG_SESSIONS` (10) at once, the oldest ending with `EVICTED_BY_LIMIT`; a hard timeout
  (`VFM_LOG_SESSION_TIMEOUT`, 30 minutes); a per-session byte rate (`VFM_LOG_BYTES_PER_SECOND`, 2 MiB/s) applied by
  **waiting, not dropping**, so a chatty container slows its own viewer and not the shared stream; names validated as
  Kubernetes names before they reach the API server; a read that is blocked is released by closing the body when the
  session ends. An unknown API failure is reported with a fixed sentence, never quoted. The content of a log never reaches
  the agent's own log. Sessions end without a message when the stream drops, and what was queued for a dead stream is
  discarded on the next one.
- **Why a session ended** is part of the protocol: `LOG_SESSION_END_REASON_COMPLETED = 7` was added (the container's log
  ended by itself, or a previous container was read in full), because "stopped" means a person stopped it. A deleted pod is
  told from an exited container by asking whether the pod still exists.
- **A previous container** is read once and never followed (`follow` is false whatever was asked).
- **Velero shortcuts** (`GET …/log-shortcuts`) find the server and node-agent pods in Velero's namespace by the controller
  that owns each pod (Deployment `velero`, DaemonSet `node-agent` or the older `restic`), because the inventory keeps no
  pod labels and that is not about to change. An installation that names them otherwise gets an empty list and the pod
  picker. Asking also marks the namespace as wanted, so a large cluster reports its pods. Velero's namespace is taken from
  the inventory's storage locations.
- **Audit.** The start is audited by the existing middleware, extended so a handler can add non-secret details:
  namespace, pod, container and whether it was a previous container, the session as the target, the actor, the outcome.
  A refusal is audited with the same facts. Stopping and streaming are not separate audit events; the start is the access.
- **The source tree needed an ignore exception.** The repository root ignores every directory called `logs/`, which would
  have kept the two new source directories out of the commit; `vfm/.gitignore` lists them back in.

### Deferred

The log viewer (follow, pause, search, wrap, download) is day 31; so are the UI shortcuts and the pod row's logs button.
Replaying lines to a stream that reconnects needs storage that this design deliberately does not have. A per-namespace
rate or session limit; metrics for sessions and bytes (M7).

### Verified

Go: 13 streamer tests (order and size of chunks, options passed on, every end reason, policy before reading, bad names,
eviction of the oldest, ten at once, hard timeout, disconnect, duplicate start, rate by waiting, no content in the agent's
log) and a config bounds test. Server: policy, request and pod-matching units; 27 e2e over two replicas with a scripted
agent (order across replicas, stop both ways, split characters, each end reason, namespace and role refusals, ownership,
API tokens refused, agent policy, not-connected, per-person limit, idle and never-opened sessions, agent disconnect,
permission taken away, an unknown session, another cluster's chunk, an oversized chunk, the audit of success and refusal,
a canary line found in no table, shortcuts, previous container). Six mutations (cluster check, ownership, policy, RBAC,
chunk size, lazy start) and a seventh for a leak found on the way were each caught by a test. Run live: the real Go
streamer and gateway manager against the real server, Redis and SSE with a synthetic log source: median 2 ms and worst
12.5 ms over 1 000 lines on ten concurrent sessions, no gaps; abandoned sessions ended by the idle timeout; a previous
container ended `completed`. Not verified: a real `pods/log` (B-2), a browser viewer (day 31), the 30-minute timeout end
to end.

## ADR-036 — The log viewer (M5 day 31)

### Context

PLAN §7.3 and §11 want a log viewer that stays usable on a log of any length and on a page left open: virtualized, ANSI
colours, follow, pause, wrap, search, download, a 50 000-line buffer. The control plane keeps no log (ADR-035), so the
viewer's buffer is the only copy a person has.

### Decision

- **Dependency:** `@tanstack/react-virtual` 3.14.13, the one the plan names (pinned, more than two weeks old). No ANSI library:
  `lib/ansi.ts` reads only SGR colour codes into data (text plus style), never markup, and drops every other escape and
  control character, so a log line cannot put HTML, a link or a cursor movement on the page. Colour starts afresh on each line.
- **Buffer:** `LineBuffer` keeps the last 50 000 complete lines, holds a partial last line until its newline, cuts a line at
  16 384 characters, and counts what it dropped, which the viewer says. It replaces its array rather than mutating it, so a
  snapshot handed to React stays valid and Pause is a held snapshot.
- **Rendering:** chunks are batched into one state update per 100 ms. Pause freezes the shown snapshot while lines keep
  arriving behind it. Follow turns itself off when the person scrolls up. Search runs over the whole buffer on plain text
  and takes you to its first match; Enter or the arrows step through the rest.
- **No silent reconnect:** `EventSource` would retry into a session that may be gone, with a gap it cannot fill. On an
  error the stream is closed and the view says the connection was lost; the person restarts it.
- **Cleanup:** closing the panel or leaving the page closes the stream and sends `DELETE`; `pagehide` sends it with
  `keepalive` for a closing tab; a start whose answer arrives after a stop is ended at once. The server's 60 s idle timeout
  remains the backstop.
- **Entry points:** a Logs button per container on the pods view, and Velero server / node agent buttons from
  `log-shortcuts` that are simply absent when there is nothing to offer or the person may not read logs there.

### Consequences

- Lines produced while a stream is down are lost, by design. A burst of 60 000 lines costs about 0.5 s to buffer.
- A search over 50 000 lines costs about 40 ms and reruns as lines arrive while a search is set.
- Highlighting marks the matching rows, not the matching words.

## ADR-037 — The alert engine (M6 day 32)

### Context

PLAN §16 day 32 wants five rule types with dedup by fingerprint, resolve notifications and a re-notify interval. PLAN §3
says an alert worker evaluates rules on a terminal phase, on BullMQ. The control plane runs as several replicas. Channels
(email, webhook, Slack) are day 33.

### Decision

- **Evaluate state, not events.** Every `ALERT_EVAL_INTERVAL_SECONDS` (default 30; 0 turns the timer off, as the tests do),
  one replica (a short Redis lock, as the command sweeper) works out for each enabled rule and each cluster it covers what
  is wrong _now_, and reconciles that with the open `alert_events`: new fingerprint → `FIRING`; gone → `RESOLVED`; still
  there → payload refreshed and, after the rule's `renotifyMinutes`, repeated. A restart, a missed tick or two replicas
  cannot lose or double an alert; the worst case is one tick late. This replaces "evaluate on a terminal phase" and BullMQ
  for now: neither is needed for 30 s latency, and BullMQ is not a dependency yet. If sub-second reaction is wanted, the
  terminal-phase hook can call `evaluateOrg` without changing the model.
- **One open row per condition.** A partial unique index `(rule_id, fingerprint) WHERE state = 'FIRING'` (which Prisma
  cannot declare, so it lives in the migration SQL) makes concurrent firing safe: the loser sees a unique violation and
  skips. Tested with six simultaneous evaluations.
- **What "fixed" means.** A backup's failure is fixed by a later `Completed` backup of the same schedule (label
  `velero.io/schedule-name`); an ad-hoc backup has no successor, so it stops counting when it leaves the lookback window
  (default 24 h) or is deleted. Many failures of one schedule are one condition naming the latest.
- **Schedule missed** = no backup of any phase within `factor` (1.5) × the schedule's _longest_ gap among its next ten runs,
  so a weekdays-only schedule is not late over a weekend. The cron parser moved from the web app into `@vfm/shared` so the
  engine and the schedule form read an expression identically.
- **Agent disconnected** looks at `status` and `last_seen_at` (not `CONNECTED`, never-connected or disabled clusters).
  **BSL unavailable** is per location. **Backup expiring** is the newest completed backup of a schedule (or an ad-hoc one)
  expiring within `withinDays` with nothing newer.
- **Notification is an interface.** `AlertNotifier.notify` receives `fired`, `resolved` or `renotify` and the channel ids;
  today's implementation logs. Resolving it records `last_notified_at`; a throw leaves it unset so the next evaluation offers
  it again. A rule with no channel creates events but notifies nobody, and a channel added later is told about what is
  already open. "Resolved" is sent only for conditions that were notified, and not when a rule is switched off or no
  longer covers the cluster (those close silently).
- **Tables.** `alert_rules` adds a `name` column to the plan's list (the rules page needs one) and keeps `channel_ids` as
  JSON with no foreign key until `notification_channels` exists (day 33). `alert_events` carries `org_id` (the plan's column
  list omits it; every org-owned table has one, §9). Deleting a rule deletes its history.
- **Access.** Rules and history are Owner/Admin only, reads included: an event names clusters, namespaces and backups across
  the org, which a cluster-scoped person may not see. Deleting a rule needs sudo. Every change is audited.

### Consequences

- Backups are read newest-first up to 5 000 per cluster per evaluation; a cluster with more would see older ones ignored.
- An agent that disconnects shows up as an alert only after the rule's minutes plus up to one interval.
- BSL and schedule conditions describe the last state the agent reported; they do not clear while an agent is away.

## ADR-038 — Channels and delivery (M6 day 33)

### Context

Alerts (ADR-037) need somewhere to go: email, a generic webhook with an HMAC-signed body, and a Slack-compatible
webhook. An org admin names the destination, the control plane sends the request from inside the operator's network, and a
Slack URL is a bearer credential.

### Decision

- **Destinations are validated, and the address connected to is the address checked** (`alerts/channels/egress.ts`). `https`
  only (plain `http` by `ALERT_WEBHOOK_ALLOW_HTTP`); no user name or password in the URL; loopback, RFC 1918, carrier-grade
  NAT and unique-local addresses refused unless `ALERT_WEBHOOK_ALLOW_PRIVATE` (on-prem receivers need it); link-local,
  multicast, unspecified and the cloud metadata address refused always. IPv6 is parsed to bytes so that `::ffff:a00:1`,
  NAT64, 6to4 and `::a.b.c.d` are judged as the IPv4 address inside them (Node normalizes `[::ffff:10.0.0.1]` to the hex form,
  which a text match would miss). The check runs again in the socket's own `lookup` at send time, a name with any refused
  address is refused outright, connections are never reused (`agent: false`) and redirects are not followed.
- **Nothing identifying the destination is stored or shown beyond the encrypted column.** `config_encrypted` holds recipients,
  URL and the signing secret (envelope encryption, context per channel). Answers show the origin only. Errors are fixed
  sentences ("the destination answered HTTP 500"), never the URL, the response body or the library's text. A test scans every
  table for a planted URL path and secret.
- **Signing.** `X-VFM-Signature: sha256=hex(HMAC(secret, "<timestamp>.<body>"))`, with `X-VFM-Timestamp`, `X-VFM-Event-Id` and
  `X-VFM-Kind`. The timestamp is signed so a captured request cannot be replayed later; the event id lets a receiver drop a
  repeat. The secret is made by the server (`whsec_…`), returned once in the answer that made it, and can be rotated.
- **Text from the cluster is data, not markup.** Control characters are stripped and lengths bounded, subjects are one line
  (no header injection), and Slack text escapes `& < >` so a failure reason cannot ping a channel or plant a link.
- **Delivery.** Each channel: up to 3 attempts (0.5 s, 2 s) for failures that pass (timeouts, 5xx, 429, resets), one for those
  that do not (4xx, refused address, bad certificate). Every outcome is a row in `alert_deliveries` (a table PLAN §9 does not
  list; it keeps the channel's name when the channel is deleted). The engine's contract (ADR-037) is kept: the notifier
  returns when at least one channel took the message and throws only when all failed, then waits five minutes before the same
  message is offered again. A channel that failed while another succeeded is not retried for that message, which would send
  the others a duplicate; it stays visible in the history, and the next re-notify is another chance.
- **Test button** does one attempt and answers `{ ok, error? }`. Rules may name only channels of their org, and deleting a
  channel removes it from the rules that named it.
- **UI.** `/admin/alerts` with Rules, Channels and History; Owner/Admin only. The signing secret is shown once with a
  "saved it" step; editing a URL channel keeps its address unless a new one is typed.

### Consequences

- A receiver on a private network is refused until the operator turns `ALERT_WEBHOOK_ALLOW_PRIVATE` on; the error says so.
- Email depends on the server's SMTP settings; without them every email delivery fails visibly.
- No queue: delivery happens inside the evaluation tick, so a slow receiver delays the others by up to its timeout (10 s,
  three attempts). Acceptable at the scale in PLAN §14; a worker is the next step if it is not.

## ADR-039 — Reports (M6 day 34)

### Context

PLAN §16 day 34: success rate over time, namespace coverage, RPO compliance per schedule, charts and CSV, "computed via SQL
over `velero_resources`", and "reports match hand-computed values on seeded data".

### Decision

- **SQL for selection, code for arithmetic.** Raw SQL is allowed nowhere that touches tenant data (`prisma/org-scope.test.ts`):
  it would bypass the org scope and the namespace visibility of PLAN §8.2, which both live in the Prisma layer. Each report
  reads narrow columns through the scoped client (a time-range `WHERE`, an index on `cluster_id, kind`) and aggregates in
  `reports/calculations.ts`, which has no I/O so every number can be checked by hand. Reads are capped (100 000 backups per
  cluster, 20 000 for coverage); past a cap the answer says `incomplete: true` and the page says so.
- **What a caller sees is what they may read.** Only clusters they can read, and on each only the backups, schedules and
  namespaces their bindings reach, by the same predicate the lists use. A namespace-scoped person gets the rate of _their_
  backups, never a figure over ones they cannot see. Any org member may ask; one with no access gets empty answers; a cluster
  that is not theirs is 404. API tokens are not accepted yet.
- **Success rate:** backups that finished in [from, to) by outcome (Completed; PartiallyFailed; Failed and FailedValidation),
  per UTC day or Monday-based week, empty buckets included. **Deleted backups stay in**: an expired backup that failed
  still failed. Rate = completed ÷ finished.
- **Coverage:** namespaces whose newest _successful, undeleted_ backup covering them (the same rule as the namespace list) is
  older than N hours or does not exist; never-backed-up first. Only times are returned, not backup names.
- **RPO compliance** is the share of the period during which the newest successful backup was no older than the objective.
  Between two successes the age grows from 0 to their distance, so the objective holds for the first `objective` of that
  stretch and not after; this is exact, not sampled. The objective is `factor` (default 1.5, as for "schedule missed") times
  the schedule's longest interval, or a `targetHours` for all. Measurement starts at the window's start or the schedule's
  creation if later; a schedule with no success yet counts its creation as the starting point, so a new one has one objective
  to make its first backup. Paused schedules and unreadable cron are left out. A success is a Completed backup carrying
  the schedule's label **in the schedule's namespace** (a test pins that two schedules of the same name in different
  namespaces are not mixed up).
- **CSV** is `?format=csv` on each report, with the formula guard shared with the audit export, and each export is itself
  audited with its row count.
- **Charts:** recharts, as the plan names it (3.10.1, pinned). The success-rate chart is a picture of the table below it, not
  the only copy of the data.

### Consequences

- A report over a very large history costs a read of up to the caps; a rollup table is the next step if that shows up.
- Windows are at most 366 days. Anything older than the retention of `velero_resources` is not there to count.
- `longest_gap` for a schedule with no success in the window counts from its last success (or creation) before the window,
  so it can exceed the window.

## ADR-040 — Restore approval (M6 day 35)

### Context

PLAN §8.4: when `requireRestoreApproval` is on, a restore request becomes `PENDING_APPROVAL`; another user with
`restore:create` (not the requester) must approve before the command is queued; both actions are audited. The plan lists
`approved_by` on `commands` and an `/approvals` endpoint group.

### Decision

- **Two switches, one direction.** The org setting `requireRestoreApproval` (default off) applies to every cluster; a cluster
  has its own switch (`clusters.require_restore_approval`) that can only _add_ approval. Effective = org OR cluster. Otherwise
  whoever administers one cluster could turn off a control the org imposed. The cluster switch is its own route
  (`PUT …/restore-approval`, `cluster:manage` plus sudo) rather than a field of the general cluster update, because
  switching it off removes a safeguard and the general update has no sudo.
- **A held request is a command, not a new table.** `commands` gains statuses `PENDING_APPROVAL` and `REJECTED` and columns
  `approved_by_id`, `rejected_by_id`, `decided_at`, `decision_note`. The state machine keeps the held state apart:
  from `PENDING_APPROVAL` only approve, reject, withdraw or time out are accepted, nothing the agent says can touch it (it was
  never told), and it is not in `NON_TERMINAL`, so it is not delivered on reconnect, not counted as in-flight and not swept
  by the agent timeout. It has its own bound (25 waiting per cluster) and its own window (`RESTORE_APPROVAL_TTL_HOURS`, default
  24); an approval starts the agent's own deadline afresh.
- **Who may decide.** Someone other than the requester, holding `restore:create` over the namespaces the restore will _write_
  (after mapping) on that cluster, with a recent re-authentication to approve (as creating it needs). The "not the requester"
  rule is checked in code and again inside the conditional `UPDATE` that changes the status, so two decisions at once
  cannot both win and the rule cannot be skipped by a code path. Rejecting needs the same eligibility, not sudo.
- **The requester is checked again at approval.** If they no longer hold the permission, approval is refused (409) and the
  request can only be rejected: an approval spends the requester's authority, and a permission withdrawn since must not be
  exercised by someone else's click.
- **Withdrawing.** The existing cancel route now takes the caller: a pending request can be withdrawn only by its requester
  (anyone else who can read the cluster gets 403, which also closes the hole that any reader could cancel any pending command).
  Withdrawn, rejected, approved and expired requests all carry a decision time and make up the Decided list (30 days).
- **Who sees a request.** The requester and anyone who could decide it; nobody else. A person with no access to the
  cluster gets 404.
- **Telling people.** By email, best effort and never blocking: up to 20 people who could approve (the requester excluded)
  when a request is made, and the requester when it is decided, with the reason sanitized to one line. Without SMTP nothing is
  sent and nothing fails. In the app, `/approvals` and a count badge in the navigation.
- **Audit.** The request is audited as made (`pendingApproval: true`, target `restore_request`), each approval and rejection
  with who and which request, and a refused attempt (such as approving your own) as DENIED, all by the request middleware.

### Consequences

- API tokens cannot approve (sudo) and cannot create restores (sudo), unchanged.
- A requester who has lost read access to the cluster cannot withdraw (cancel needs `cluster:read`); the request expires.
- The approvals list is computed per request on each read, with a rights check per cluster; fine at the scale of PLAN §14,
  and the badge refetches once a minute per open tab.

## ADR-041 — Starting M7 before M6's golden path 12 has run

### Context

PLAN §0 rule 1: do not start the next milestone until every exit criterion of the current one passes. M6's criteria are
"golden path 12 passes" and "reports match hand-computed values on seeded data". The second holds (ADR-039). The first
needs a real Velero with a deliberately broken storage location on the kind clusters, which cannot be built on this host
until `fs.inotify.max_user_instances` is raised with root (blocker B-2, open since M0). The same blocker holds back M5's
latency target and the M3 and M4 human checkpoints. Everything that golden path 12 exercises (a failed backup produces an
alert, a signed webhook arrives, the alert resolves when a later backup completes) is covered against real Postgres and a
real local receiver in `alerts.e2e` and `channels.e2e`; what is not covered is Velero itself producing the failure.

### Decision

On the owner's instruction to continue ("resume next") after M6 day 35, work moves on to M7, as it did to M1 before M0 exited
(ADR-010). This is a recorded deviation, not a pass: **M6 is not closed**, golden path 12 (R-151) stays partial, and the
list of what B-2 holds back is kept in `NEXT_STEPS.md` so that it is run first once the host is fixed. Nothing in M7 depends
on kind, except the load test's realism (day 38), which uses a fake agent by design.

### Consequences

- The M7 exit criteria and the human checkpoint at its end do not include the unrun items; they are listed there.
- If golden path 12 fails when it is finally run, the fix lands in M6's code, not M7's.

## ADR-042 — Load-test findings and the fixes taken (M7 day 38)

### Context

The fake-agent load test (`docs/LOADTEST.md`) ran 200 agents and 100 browsers against one Node process. Agents, reconnects and
event delivery held. List endpoints and command latency did not (list p95 1.3-2.1 s against 300 ms; commands 2.2 s against 1 s).
A CPU profile put 31 % in Prisma's JS layer; Postgres itself was not slow.

### Decision

- Reports, fleet and SSE permission checks use a fixed number of queries; fleet aggregates and coverage inputs are shared for 5 s.
- `RbacService` caches cluster-in-org and per-user facts for 2 s (`rbacOptions.cacheMs`). **A revoked grant can keep working for
  up to 2 s.** This is accepted because sessions, MFA and token revocation are checked separately and uncached. Tests set it to 0.
- `DATABASE_POOL_MAX` is configurable (default 30).
- Inventory SSE events are coalesced per cluster for 250 ms. A 1 s window was tried and rejected (worse latency, same volume).
- The targets are **reported as not met**, not tuned around. The next step is replicas, a denormalised fleet summary, a cheaper
  coverage report and cheaper SSE delivery, and the owner decides at the M7 checkpoint.

### Consequences

- Mutating tests need the caches off; the harness does that. A test of the cached path is `rbac-cache.test.ts`.
- R-118/R-119/R-120 stay open.

## ADR-043 — Resilience tests by fault proxy; master-key re-wrap and CA rotation as operator CLIs (M7 day 39)

### Context

Day 39 asks for chaos-style tests (Postgres and Redis restarts, a partition, a slow agent) with no lost or duplicated commands,
and for key and CA rotation. The host has no root, and restarting the shared dev containers would break other work.

### Decision

- Faults are injected with an in-process TCP proxy that resets connections and refuses new ones (`test/chaos-proxy.ts`). The
  app is started through it (`createTestApp({ databaseUrl, redisUrl })`) and so is the agent link. Real services, real
  protocols, deterministic, runs in CI.
- A lost database or cache now answers **503 with `Retry-After: 5`** and a fixed sentence, not 500 (`isDependencyOutage`). A
  client and a load balancer should retry the one and not the other. It is logged as one warning line, without a stack.
- `rewrap` (G-9) and `ca-rotate` (G-12) are **CLIs, not REST endpoints**: there is no platform-administrator role in the model
  (R-083 stops at org roles), and an endpoint that can replace the CA would be the most dangerous in the API. They start only
  config, database and key ring, so they run next to a live server. The cost: they are not in the audit log (see
  `RESILIENCE.md`).
- CA rotation reuses the bundle agents already receive: states ACTIVE / STAGED / RETIRING on `certificate_authority` (new
  column `state`, migration `20261018000000_ca_rotation`). Only ACTIVE signs; ACTIVE and RETIRING verify; the bundle holds all
  three. `promote` and `retire` wait one `AGENT_CERT_LIFETIME` (7 days) because that is the longest an agent can go without
  renewing and learning the new CA. Replicas poll every 30 s and the gateway reissues its server certificate when the set changes.

### Consequences

- Replica loss (R-121) is still unproven; it needs two processes (day 41).
- A forced `promote` before agents have renewed will lock out agents that still trust only the old CA. That is the operator's
  explicit choice, logged.
- The shared test database's `certificate_authority` table is changed by `ca-rotation.e2e`; the suite settles it back to one ACTIVE row.

## ADR-044 — Metrics, log fields and the tracing hook (M7 day 40)

### Context

PLAN §13 lists the metrics the control plane must expose and day 40 adds a dashboard, documented log fields and an optional
tracing hook. The registry and the `:9090` listener existed since M0; only the runtime's own metrics were registered.

### Decision

- All control-plane metrics are declared in one file (`metrics/metrics.ts`) and recorded where the event happens: stream
  attach and detach, SSE open and close, every command transition (through `announce`, which every transition already calls),
  the REST middleware, alert delivery, rate-limit refusals. **Labels are enums and route templates only**; a test fails on any
  other label name.
- The work-queue depth is a gauge read from the database **at most every 5 s** whatever the scrape rate, under a pinned
  `unscoped` call site (it spans every org by nature). Commands are the only queued work.
- Metrics are per replica, as Prometheus expects; the dashboard sums.
- The request log line is an **allowlist** (`serializeRequest`): the query string is dropped. Found while documenting the fields:
  the SSO callback's one-time `code` and `state` were being written to the log in `url` and `query`. They are short-lived and
  bound to a browser-held verifier, so this was low severity, but a log should not hold them. Whole request and response header sets
  also went, which cuts log volume.
- Tracing: `@opentelemetry/api` (exact version, no known advisories) is a dependency, so `withSpan` is always a no-op-safe call.
  The SDK is **not** shipped: `OTEL_ENABLED=true` loads `@opentelemetry/sdk-node` if the operator installed it and warns and
  continues if not. One span exists today (`command.deliver`).
- The dashboard and alert rules are plain files under `deploy/observability/`, checked against the registry by a test.

### Consequences

- The dashboard has not been imported into a real Grafana and the rules not run through `promtool`; the chart (day 41) is the
  place to do both. Tracing has not been run against a collector.
- A new metric needs a line in `OBSERVABILITY.md`; the label allow-list in `observability.test.ts` is the review point.
- `pnpm audit` reports two moderate findings (vitest, dev-only, present before today). Nothing high or critical.

## ADR-045 — Reports are shared answers (M7)

**Status:** accepted · **Date:** 2026-10-21

### Context

Profiling the load test (docs/LOADTEST.md) showed that the three reports (success rate, RPO, coverage) took 0.4–1.0 s of event-loop
time each and, asked by 100 people, used most of the process's CPU, starving every other endpoint and the event stream.

### Decision

- `ReportsService` shares each answer, single-flight, for `reportOptions.resultCacheMs` (30 s; 0 in tests). A report already
  carries its own `generatedAt`; it is a summary, not a live view.
- **The key is what the caller may see**: organization, report, parameters, the clusters they can read, and either `all` (every
  one of those clusters is fully visible to them, so the answer is identical for everyone in that position) or their user id (they
  are limited to some namespaces, so the answer is theirs alone). A number computed for someone who sees more is never served
  to someone who sees less. A mutation that drops the user id from the key fails
  `reports.e2e.test.ts` ("shares an answer between people who see the same things…").
- `from`/`to` are keyed to the minute, because their defaults are "now".
- The coverage report also reads its inputs once for all callers of the same clusters (5 s), and `coverageOfMany` parses each spec
  once rather than once per namespace; both are equivalent to the old code (randomised test) and neither was the main cost.

### Consequences

- A report can be up to 30 s old. Access changes are not delayed by it: the visibility check runs on every request and is part of the
  key, so a person whose access narrowed or was revoked gets a different key (their own answer, or a refusal), never the old shared one.
- The body of a shared answer carries the time bounds of whoever asked first within the minute.
- Memory: at most 500 cached answers per replica, cleared when exceeded; an answer is up to ~1 MB at 200 clusters.
- Not addressed: the reports still cost 0.4–1 s each on a miss; a precomputed table is the next step if the 30 s window is not
  enough at larger sizes.

## ADR-046 — Cluster-scoped restores, agent budgets and production Redis (threat-model G-4, G-10, G-11, G-13)

### Context

Four open gaps in `THREAT_MODEL.md`. Velero v1.18.4 treats `RestoreSpec.IncludeClusterResources == nil` as **true**, so a restore
with the field unset can recreate CRDs, ClusterRoleBindings and PersistentVolumes even for a namespace-scoped restorer.

### Decision

- **G-4**: the agent policy gains `allow_cluster_scoped_restore` (proto `AgentPolicy.deny_cluster_scoped_restore = 7`, inverted so an
  older agent that does not send it decodes as "allowed", its old behaviour). When denied, the agent refuses any restore whose
  `includeClusterResources` is not explicitly false (`policy.CheckRestoreClusterScope`). Chart value `policy.allowClusterScopedRestore`,
  default **true** (owner decision B1). An agent with no policy at all reads as restricted (denied).
- **G-10**: each agent stream has a token bucket (`AGENT_MESSAGES_PER_SECOND` 100, `AGENT_MESSAGE_BURST` 1000). Over it the control plane
  closes the stream with `RESOURCE_EXHAUSTED`; the agent reconnects with backoff. Log chunks are exempt (they have their own byte caps).
- **G-11**: `Enroll` is limited per source address (Redis counter `vfm:rl:enroll:<ip>`, 30/min) and by an in-flight cap per replica (16).
  The in-flight counter is taken before the first `await`, otherwise concurrent calls all pass the check.
- **G-13**: with `NODE_ENV=production` the environment schema refuses a Redis URL without a password; a URL that is not `rediss://` is a warning.

### Consequences

Each has a test that fails without it (token bucket unit tests with an epsilon for float refill, `streams.e2e`, gateway enrol tests,
`env.schema` tests, agent policy tests, chart test). A very large first rollout behind one NAT needs `gatewayEnrollPerMinute` raised.

## ADR-047 — The control plane as one image, a chart, and the SPA served by the server (M8)

### Decision

- `server/Dockerfile` builds the API, the gateway and the built web app into one non-root, read-only-root-filesystem image; the server serves the
  SPA from `WEB_DIST_DIR` under the same security headers and CSP as the API (`web-static.ts`). HTTP keep-alive is 65 s (above common load balancers' 60 s).
- `deploy/helm/vfm-control-plane`: 3 replicas (HPA 3–6, PDB), `DATABASE_POOL_MAX` 15 per replica so that replicas × pool stays below Postgres'
  100 connections, NetworkPolicy, migration Job, optional retention CronJob, examples. The chart has a rendered-manifest hardening test.
- Air-gap: `deploy/airgap/*` loads images from a tar and `verify-airgap.sh` installs with `docker network --internal` so any outbound call fails.
- Upgrade: migrations are expand-only for one release; `verify-upgrade.sh` rehearses old image → migrate → new image under traffic.
  `migrations.test.ts` rejects destructive statements.

### Consequences

Replica default 3 follows the four-replica load run; three exactly was not measured (owner list C9).

## ADR-048 — Retention (R-101)

### Decision

A daily job (one replica per interval, a Redis lock) deletes: events > 1 h, finished commands > 180 d, expired cached files, soft-deleted
objects > 7 d (backups 400 d so the 366-day reports still see them), and audit events older than each organization's own
`auditRetentionDays` (default 400). With `auditExportBeforeDelete` the rows are written to CSV (`AUDIT_EXPORT_DIR`, `.partial` then rename) before deletion,
and an organization that asks for export but cannot have it loses nothing (the run is reported `partial`).
The audit table stays append-only: a trigger permits DELETE only to role `vfm_audit_retention`; the purge runs `SET LOCAL ROLE` to it, in batches
of 5 000, with the organization id an explicit statement argument (raw SQL is pinned by `org-scope.test.ts`).
`node dist/retention.js` runs the same job from a CronJob with a separate login.

### Consequences

Whether the application's own login should be a member of the role is owner decision C10.

## ADR-049 — Backup download is a signed link, never the data (R-055)

### Decision

`POST /orgs/:o/clusters/:c/backups/:name/download-url` is gated on the organization setting (default off), `backup:download` over every namespace
of the backup, and sudo. It sends `GetBackupDownloadUrl`; the agent creates a Velero `DownloadRequest` and returns the signed URL. The control plane holds the
URL in Redis only for the command id, hands it to the single waiting request once (`takeSignedUrl`), responds `Cache-Control: no-store`, and records
only `{linkIssued: true}`. Only http(s) links living < 30 minutes are accepted; a link on any other command's result is ignored.
`readOnly` agents refuse it.

## ADR-050 — An agent adopts a new bootstrap token after it was disabled (found by golden path 11)

### Context

Disabling a cluster revokes its identity. Re-enabling issues a new bootstrap token, but the agent kept its stored (revoked) identity and was refused forever.

### Decision

The agent stores the digest of the token it enrolled with (`enrolled-with` in its Secret). If the configured token has a different digest and the stored
identity is refused, it enrols with the new token (`tryNewToken`) and renewals carry `EnrolledWith`. A refused token is remembered so it is not retried every backoff.

## ADR-051 — Single-node kind and a seed for development (R-129/R-130 substitute, R-131)

### Decision

Blocker B-2 (inotify limits need root) is sidestepped with one single-node kind cluster (`VFM_DEV_SOLO=1`, `deploy/dev/kind/vfm-a-solo.yaml`). Golden paths run against it
(`e2e/golden.mjs`), with the control plane as containers on the kind network (`e2e/stack.sh`). Agent images get a unique tag per load (kind does not re-pull a reused tag).
`pnpm run seed` (compiled, because `tsx` emits no decorator metadata) creates the development accounts through the server's own services and refuses to run in production.
The two-cluster `make dev-up` remains for hosts that can raise the limits.

## ADR-052 — SOW alignment: agent connectivity kept, FR-02/10/15/19/20 and LDAP added

### Context

The customer SOW (HLRD v1.0, 2026-10-21) FR-03 describes connecting with a service account or kubeconfig. This product connects through an outbound-only agent (ADR-001, P1).

### Decision

Keep the agent: it is a "supported authentication mechanism" under FR-03 and holds the control plane to no kubeconfig. Enrolment validates the agent's identity and the agent's RBAC is fixed by the chart.
Added: cluster `environment_type`, `api_endpoint` (informational, never dialled) and `owner` (FR-02); Velero compatibility (`veleroCompatibility`, shared `veleroCompatibility()`): newer than primary warns, older than the window or unreadable blocks commands (FR-20);
browser-side restore risk list with an explicit acknowledgement (FR-10; CRD/StorageClass checks are not done because the control plane does not hold them and the restore wizard is same-cluster); PDF output for reports using `pdfkit` (pure JS, no network, FR-15);
`GET /orgs/{orgId}/config-export`, a secret-free JSON record (FR-19; export only, no import); SOW role display names over unchanged enum values. ClamAV (FR-18, Could) is not built.

## ADR-053 — LDAP sign-in for existing users (reverses the plan's "LDAP v1.1")

### Decision

`ldapts`; configured by environment (`LDAP_*`). On a failed local password, search by e-mail with an optional service account, then bind as the one matching entry. Empty passwords, plain `ldap://` without STARTTLS and non-unique matches are refused.
The directory is asked for unknown addresses too, so response work does not reveal which accounts exist. No provisioning and no group mapping: accounts, roles and MFA stay as they are in VFM.
