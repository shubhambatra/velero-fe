# Control plane

NestJS service implementing the REST API, the agent gRPC gateway, RBAC, audit,
alerts and reports described in `PLAN.md` §4.2, §8–§10.

## What exists today (M0 day 3)

- zod-validated configuration (`src/config/env.schema.ts`) — the authoritative
  list of environment variables. Startup aborts naming every invalid variable
  without printing its value.
- pino JSON logging with request correlation; `X-Request-Id` on every response.
- RFC 9457 `application/problem+json` errors for every failure.
- Strict security headers and CSP, applied from day 1 (§12.1).
- `/healthz` liveness, `/readyz` readiness (Postgres + Redis), and `/metrics`
  on its own port (default 9090).
- `redact()` (`src/common/redact.ts`) — the single redaction chokepoint of
  §12.1, used before logging and before persisting command payloads or audit
  details.
- Prisma schema and first migration: `users`, `organizations`, `memberships`.

## Authentication (M1 day 4)

- One-time first-admin setup: a token is printed to the logs on first start
  while `users` is empty, stored hashed in Redis with a 24 h TTL, and burned
  atomically on use. **There is no open self-signup** (§16 day 4).
- Login and logout with **argon2id** (19 MiB, t=2, p=1), a 12-character
  minimum, and a bundled 97 747-entry breached-password list — no external
  calls, so it works air-gapped (§8.3, §1.1 P6).
- Redis-backed sessions: httpOnly, Secure, SameSite=Lax; **12 h absolute and
  1 h idle**; rotation; "sign out everywhere" (§8.3, §9).
- Double-submit **CSRF** on every state-changing call, compared against the
  token held in the session rather than only against a second cookie.
- Brute-force protection: per-account and per-IP counters with progressive
  delay and a timed lockout (§8.3).
- Authentication is **deny by default** — `SessionGuard` and `CsrfGuard` are
  global, so a route is protected unless it carries `@Public()`.

MFA, sudo re-auth, orgs, OIDC and RBAC are days 5–9. The agent gateway and
every Velero operation are later milestones. There are no stubbed handlers
pretending otherwise (§0 rule 7).

## Running locally

```bash
# from vfm/
make dev-up                     # Postgres, Redis, MinIO, Mailpit, Dex
cp server/.env.example server/.env
pnpm --filter @vfm/server prisma:deploy
pnpm --filter @vfm/server dev
```

Then `curl -i localhost:3000/healthz` and `curl -i localhost:3000/readyz`.

## Contracts

`prisma/schema.prisma` and `openapi.yaml` are two of the three contracts in
§0 rule 5. After changing either, run `make gen` from `vfm/` and record the
change in `docs/DECISIONS.md`. CI fails if the committed `openapi.yaml` differs
from what the decorators produce.

## Tests

```bash
pnpm --filter @vfm/server test       # unit; no services needed
pnpm --filter @vfm/server test:e2e   # boots the app against the dev stack
```

The e2e suite needs `make dev-up` and a `vfm_test` database:

```bash
docker exec vfm-dev-postgres createdb -U vfm vfm_test
DATABASE_URL='postgresql://vfm:vfm-dev-password@localhost:55432/vfm_test?schema=public' \
  pnpm --filter @vfm/server exec prisma migrate deploy
```

Override the targets with `TEST_DATABASE_URL` and `TEST_REDIS_URL`. CI runs the
same suite against service containers.
