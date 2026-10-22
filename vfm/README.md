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

| Path               | Contents                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proto/`           | agent ↔ control-plane protocol — a contract (PLAN.md §0 rule 5)                                                                                                                 |
| `agent/`           | Go agent that runs inside each managed cluster                                                                                                                                  |
| `server/`          | NestJS control plane: REST API, agent gateway, RBAC, audit                                                                                                                      |
| `web/`             | React 19 single-page application                                                                                                                                                |
| `packages/shared/` | types and constants shared by `server` and `web`                                                                                                                                |
| `deploy/dev/`      | local development environment (compose + kind clusters)                                                                                                                         |
| `deploy/helm/`     | Helm charts for the control plane and the agent                                                                                                                                 |
| `docs/`            | progress log, decisions, threat model, load test, release checklist; operator and user guides (`OPERATIONS.md`, `AIRGAP.md`, `USER_GUIDE.md`), generated `API.md` and `RBAC.md` |
| `e2e/`             | golden paths against a real kind cluster, Velero and MinIO                                                                                                                      |

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

No root to raise the inotify limits for two kind clusters? `VFM_DEV_SOLO=1 make dev-up` builds one single-node cluster instead.
Seed development accounts with `pnpm --filter @vfm/server run build && pnpm --filter @vfm/server run seed`, and run the
real-Velero golden paths with `vfm/e2e/stack.sh up`, `vfm/e2e/load-agent.sh` and `node vfm/e2e/golden.mjs` (see `docs/OPERATIONS.md` § 10a).

`make` with no target lists everything available. `make dev-down` tears the
environment back down.

## Running each service

All commands run from `vfm/` unless stated. Run `make setup` once first (installs workspace dependencies).

### Everything in Docker (quickest)

```bash
docker compose -f deploy/quickstart/compose.yml up -d --build   # or `docker compose up -d --build` at the repository root
docker compose -f deploy/quickstart/compose.yml logs control-plane | grep -A8 "no users yet"   # one-time setup token
```

Open <http://localhost:3000> (UI and API; the agent gateway is on `:8443`). Stop with `... down` (`down -v` also wipes the database).
Throwaway passwords: for trying the product only.

### Backing services (Postgres, Valkey, MinIO, Mailpit, Dex)

```bash
docker compose --env-file deploy/dev/dev.env -f deploy/dev/docker-compose.yml up -d --wait
```

Ports are on `127.0.0.1` only; Postgres is `55432`, Valkey `56379`. Tear down with `deploy/dev/scripts/dev-down.sh`.

### Control plane (API + agent gateway) — `server/`

```bash
cd server
cp .env.example .env          # then set VFM_MASTER_KEY: openssl rand -base64 32
pnpm exec prisma migrate deploy
pnpm dev                      # http://localhost:3000, hot reload; metrics on :9090
```

Optional: `pnpm build && pnpm seed` creates development accounts (an admin, two orgs, a user per role). A fresh database otherwise shows **Setup** in the UI.

### Web UI — `web/`

```bash
pnpm --filter @vfm/web dev    # http://localhost:5173, talks to the control plane on :3000
```

In production the control plane serves the built UI itself (`pnpm --filter @vfm/web build`), so there is no separate web process.

### Agent — `agent/` (one per managed cluster)

In the UI use **Clusters → Add cluster**; it prints a Helm command with a single-use bootstrap token (valid 24 h):

```bash
helm install vfm-agent oci://ghcr.io/shubhambatra/charts/vfm-agent -n vfm-system --create-namespace \
  --set controlPlane.address=<host>:8443 --set-file controlPlane.caBundle=ca.pem --set enrollment.token=<token>
```

Out-of-cluster for development: `cd agent && go run ./cmd/agent -dev -kubeconfig ~/.kube/config` with the settings from `agent/README.md`
(control-plane address, CA bundle and enrollment token, as `VFM_*` variables or flags).

### Clusters with Velero for local testing

```bash
make dev-up                   # two kind clusters + Velero (needs raised inotify limits)
VFM_DEV_SOLO=1 make dev-up    # one single-node cluster, no root needed
make smoke                    # a Velero backup must complete on each cluster
node e2e/sim-clusters.mjs     # simulated clusters, no kind required (see docs/OPERATIONS.md §10a)
```

### Checks

`make test`, `make lint`, `pnpm -r typecheck`.

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
