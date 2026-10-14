# Velero Fleet Manager

Manage [Velero](https://github.com/velero-io/velero) across many Kubernetes
clusters from one control plane.

A small Go agent runs in each cluster and dials **outbound** to the control
plane over a mutually authenticated gRPC stream. The control plane sends typed
commands; the agent executes them by creating or patching Velero custom
resources and streams back status, logs and cluster health. Backup data never
passes through the platform — Velero writes it straight to object storage.

**[`PLAN.md`](./PLAN.md) is the build specification.** It is a symlink to
`VELERO_FLEET_PLAN.md` at the repository root. Read it before changing anything
here; where this README and the plan disagree, the plan wins.

## Layout

| Path               | Contents                                                        |
| ------------------ | --------------------------------------------------------------- |
| `proto/`           | agent ↔ control-plane protocol — a contract (PLAN.md §0 rule 5) |
| `agent/`           | Go agent that runs inside each managed cluster                  |
| `server/`          | NestJS control plane: REST API, agent gateway, RBAC, audit      |
| `web/`             | React 19 single-page application                                |
| `packages/shared/` | types and constants shared by `server` and `web`                |
| `deploy/dev/`      | local development environment (compose + kind clusters)         |
| `deploy/helm/`     | Helm charts for the control plane and the agent                 |
| `docs/`            | progress log, decision log, release checklist                   |

This tree sits under `vfm/` rather than at the repository root, which hosts an
unrelated legacy application. See `docs/DECISIONS.md` ADR-003.

## Getting started

Requires Node 22+, Docker, kind, kubectl, helm, the Velero CLI, Go 1.27+, `make`
and `buf`. Check what is present:

```bash
make doctor
```

Then:

```bash
make setup      # install workspace dependencies (pnpm via corepack)
make dev-up     # Postgres, Valkey, MinIO, Mailpit, Dex + two kind clusters with Velero
make smoke      # assert a Velero backup completes on both clusters
make test       # unit tests, TypeScript and Go
make lint       # eslint, prettier, golangci-lint, buf lint
```

`make` with no target lists everything available. `make dev-down` tears the
environment back down.

## Current state

This is an in-progress build. `docs/PROGRESS.md` records what each session
completed and what is deferred; `../DEVELOPMENT_STATUS.md` tracks every plan
requirement with its verification status. Nothing is reported as working unless
a check actually ran — PLAN.md §0 rule 7.

## Development notes

- Velero support window: **v1.18.4** primary, **v1.16.2** oldest supported.
  Never write code against a Velero field without reading its Go type from the
  pinned release first (PLAN.md §0 rule 4).
- Three files are contracts: `proto/`, `server/prisma/schema.prisma` and
  `server/openapi.yaml`. Change them deliberately, run `make gen`, and record
  the change in `docs/DECISIONS.md`.
- Security requirements in PLAN.md §12 apply from day 1, not in a later
  hardening phase.
- The product name lives in one constant per package
  (`packages/shared/src/product.ts`, `agent/internal/config/product.go`) so a
  rename stays trivial.
