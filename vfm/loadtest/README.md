# VFM load test

Drives a real control plane with simulated agents and browsers and checks the result
against PLAN §13. The tool is `agent/cmd/loadtest` (code in `agent/internal/loadtest`).

## Pieces

- **Fixture**: JSON from `server/scripts/loadtest-provision.ts` holding the API and gateway
  addresses, the gateway CA, an admin session, one single-use bootstrap token per cluster
  and a session per user. Enrolment consumes the tokens: re-provision between runs.
- **Simulated agents**: the production `gateway.Manager` (enrolment, mTLS, Hello, heartbeat,
  backoff) with generated inventories (pods, nodes, namespaces, PVCs, events, Velero objects
  of 2–4 KB), snapshot chunks, delta batches and churn. A few clusters are made large
  (`--big-pods`) so the pod-scope threshold is crossed.
- **Virtual browsers**: one SSE stream plus a weighted loop over the list/report endpoints.
- **Command issuer**: `refresh-status` at a steady rate; time to reach an agent, and to succeed.
- **Reconnect storm**: at `--storm-at` every agent connection is cut at once.
- **Sampler**: CPU and RSS of the server (`--server-pid`) from `/proc`.

## Run

```
go build -o loadtest ./agent/cmd/loadtest
./loadtest --fixture fixture.json --agents 200 --users 100 --duration 5m \
  --server-pid <pid> --report loadtest.json
```

Exit status 0 when every target held, 1 when one failed, 2 on usage or fixture errors.
Samples before `ramp + warmup` are dropped; HTTP 429 is counted apart from errors.

Flags: `--fixture --duration --warmup --ramp --agents --users --pods --big-pods
--velero-objects --nodes --namespaces --events-per-sec --commands-per-sec --user-think
--storm-at --pod-threshold --report --server-pid --seed` (see `--help`).

## Targets checked

List endpoints p95 < 300 ms (reports are shown but not held to it); command reaches agent
p95 < 1 s; inventory change reaches a browser p95 < 3 s; every agent connected; all agents
back within 60 s of the storm.
