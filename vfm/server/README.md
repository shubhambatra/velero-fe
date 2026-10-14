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

Authentication, RBAC, the agent gateway and every Velero operation are later
milestones. There are no stubbed handlers pretending otherwise (§0 rule 7).

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
pnpm --filter @vfm/server test
```

Integration tests against real Postgres and Redis via Testcontainers arrive
with the first database-backed feature in M1 (§15).
