# Load test (M7 day 38)

**Result: the PLAN §13 targets are NOT all met.** Agents, reconnects and the SSE
path hold. The UI list endpoints (p95 < 300 ms) and command latency (p95 < 1 s) do
not, on one Node process under the load below. This report states that plainly; it
needs the human checkpoint's decision (see "What remains").

## Method

- `server/test/loadtest-provision.e2e.test.ts` provisions an org, 200 clusters (real
  bootstrap tokens), 100 users (team VIEWER binding per cluster) and sessions, and
  writes a fixture JSON. Run it fresh before each run (bootstrap tokens are single use).
- `agent/cmd/loadtest` (Go) runs 200 agents (real Enroll, mTLS Connect, Hello,
  snapshot, heartbeats, inventory events, command ack/result, resync), 100 browsers
  (SSE `/stream` plus list loops, 5 s think time, reports at most every 4 s), and a
  command issuer. It samples server RSS/CPU from `/proc`, cuts every agent connection
  once (reconnect storm) and checks the targets. Exit 0 = held, 1 = target failed.
  See `loadtest/README.md`.
- Per agent: 5k-pod-class snapshot shape, 0.27 inventory changes/s per cluster
  (deliberately aggressive; real clusters change far less), ~0.5 commands/s fleet-wide.
- Host: one 16-core, 13 GB machine running the server (single Node process, no
  replicas), Postgres, Redis, and the simulator together. Numbers are therefore
  pessimistic for the server and optimistic for the network.

## Final run (5 min, 200 agents, 100 users)

| Target (PLAN §13)                               | Result                                                      |          |
| ----------------------------------------------- | ----------------------------------------------------------- | -------- |
| 200 connected clusters                          | peak 200                                                    | PASS     |
| Agents reconnect within 60 s                    | all back in 12.4 s (p95 12.0 s) after a cut of all 200      | PASS     |
| Resource event reaches browser p95 < 3 s        | p95 1.03 s (1.38 M deliveries)                              | PASS     |
| UI list endpoints p95 < 300 ms                  | p95 1.26–1.75 s (p50 295–445 ms)                            | **FAIL** |
| Command reaches agent p95 < 1 s                 | p95 2.2 s (p50 485 ms)                                      | **FAIL** |
| 100 concurrent users                            | held, 0 stream reconnects, 1–14 request errors per series   | PASS     |
| Agent footprint < 100 MiB / 100m CPU on 5k pods | **not measured here** (the simulator is not the real agent) | OPEN     |
| 50k Velero objects, 20k pods per cluster        | **not exercised** at that size                              | OPEN     |

Server process: CPU avg 134 %, peak 192 %; RSS 293 MB → 1.67 GB.
`GET report coverage` p50 11 s, p95 25 s: reported, not held to the list target, and
the worst endpoint (see below).

Agents alone (no users) meet the command target (p95 397 ms) but ramp took 57 s.

## What was changed (ADR-042)

- Fixed-query-count rewrites: reports (`successRate`, `coverage`, `rpo`),
  `RbacService.matrix/visibilities/heldAcrossOrg`.
- Shared 5 s caches for fleet aggregates and coverage inputs.
- SSE: one per-user permission matrix instead of per-event lookups; per-cluster event
  coalescing (250 ms).
- `RbacService` 2 s cache for cluster-in-org and per-user facts (a revoked grant can
  work up to 2 s). Tests set it to 0.
- `DATABASE_POOL_MAX` (default 30).
- Effect: the first run, on the old code, was far worse (list p95 in the tens of
  seconds); the last three runs sit at 1.2–2.1 s. Most of the rest is not database
  time: Postgres logged 14 statements over 150 ms in a 5-minute run.

Tried and rejected: a 1 s coalescing window left delivery volume unchanged and made
event latency worse (p95 1.7 s), so it went back to 250 ms.

## Where the time goes

CPU profile of the final run (`node --cpu-prof`): 31 % Prisma client (its JS query
layer), 15 % application code, 6 % GC, ~25 % idle across the whole profile including
start-up. The main thread stalls in bursts, so p50 stays low and p95 does not.
The load is per-request query count plus SSE writes (~4.6 k deliveries/s) on a single
event loop.

## What remains (owner decision at the M7 checkpoint)

1. Run two or more server replicas behind the load balancer and re-measure (the
   simulator needs to spread over replicas). Not tested. Day 41 Helm work.
2. Denormalise the fleet summary onto the cluster row at ingest.
3. Coverage report: precompute or cap; 11 s p50 is not acceptable for a page people open.
4. Cheaper SSE delivery (serialise once per event, not per stream).
5. Judge the simulator: 0.27 changes/s per cluster is far above real use; a calmer
   profile would likely pass, but that has **not** been run and should not be assumed.
6. Measure the real agent footprint on a 5k-pod kind cluster (blocked with B-2).

## Re-measure after the coverage work (2026-10-21)

Same method, same host (load average ~3 from unrelated processes), three 5-minute runs, 200 agents, 100 users.
**The §13 list and command targets are still not met, and these runs were slower than the day 38 figures above**
(list p95 3.4–4.5 s, not 1.2–1.8 s; command-to-agent p95 5.3 s; event-to-browser p95 3.8 s, over its 3 s target this time).
They are not comparable run to run: the day 38 numbers were not reproduced on today's host, and nothing here explains
the gap, so treat the absolute values as unreliable and the _direction_ of each change as the only usable signal.

- Run 1 used `LOG_LEVEL=debug` and `LOG_PRETTY=true` by accident (`server/.env` is read by the app itself). Run 2 repeated it
  at `info`/JSON: the numbers did not change, so logging was not the cause.
- Coverage report: `coverageOfMany` (each spec parsed once, not once per namespace) is exactly equivalent to `coverageOf`
  (randomised test) but measured **no faster** on an idle server (1.0–1.4 s old, 1.0–3.8 s new): the cost is reading ~34 k
  backup rows with their JSON through Prisma, not the matching loop. A shared 5 s single-flight cache of those reads
  (`reportOptions.coverageInputsCacheMs`) gave about 10 % on the other endpoints and the report **still times out under
  load (0 completions in 188 tries)**. It is not fixed.
- Not done: fleet summary denormalised at ingest, serialise-once SSE, replicas (still the largest untested lever).

## Replica runs (2026-10-21)

Same rig and load as above, the server run as N Node processes (separate ports) behind a TCP round-robin balancer
(`lb.js`, connection level, **no health checks**) with one shared Postgres and Redis. The simulator and all replicas share one
16-core host, so this understates what separate machines would do. Single 5-minute runs, not repeated.

| Replicas | List p95 (p50)            | Command to agent p95 | Event to browser p95 | Coverage report p95 | Targets met                         |
| -------- | ------------------------- | -------------------- | -------------------- | ------------------- | ----------------------------------- |
| 1        | 3.4–4.5 s (2.2–3.9 s)     | 5.3 s                | 3.8 s                | timed out           | agents, storm                       |
| 2        | 1.0–1.6 s (0.47–0.68 s)   | 1.56 s               | 1.6 s                | 24.6 s              | agents, storm, events               |
| 4        | 0.56–0.90 s (0.16–0.26 s) | 0.92 s               | 0.78 s               | 13.0 s              | agents, storm, **commands**, events |

With four replicas, **commands (p95 916 ms), events (780 ms), connection and reconnect all meet §13, and there were 0 request
errors. The list endpoints still do not: p95 is 2–3x the 300 ms target, with p50 near 170 ms.** The remaining tail is not
replica count alone (2 to 4 replicas bought about 40 %), which points at per-request work and at the tail of a shared
Postgres. It needs profiling before another change is chosen. Reports are not held to the list target.

**Pool size matters.** The first four-replica run used the default `DATABASE_POOL_MAX=30`: 4 x 30 exceeds Postgres's default
`max_connections` of 100, and 5 to 8 % of list requests returned 500 ("too many clients"). It is an operations rule, not a bug:
replicas x `DATABASE_POOL_MAX` (plus anything else connected) must stay under `max_connections`. Run 6 used 15. This belongs in
`docs/OPERATIONS.md` (day 43) and the Helm chart (day 41).

### Loss of one replica (R-121), one run

Four replicas, `kill -9` of replica 2 at about 150 s, while 200 agents and 100 users were active.

- The run completed with 200 agents connected at its peak (agent connection state during the minutes after the kill was not sampled); 31 browser
  streams reconnected; 2 to 6 list requests failed per endpoint (against 0 in the same configuration without a kill).
- Commands: 1 781 created, 1 777 `SUCCEEDED`, and 4 not terminal. All four were created in the last second of the run, so they were in
  flight when the simulator stopped, not lost. Three commands show `attempts = 2` and finished `SUCCEEDED`: re-delivery after the
  kill worked.
- The reconnect-storm figure in this run (28.7 s against 4.9 s without a kill) is **not** a result: the balancer kept offering the
  dead replica to a quarter of the reconnects. A real balancer health-checks.
- Not shown: that no command ran twice. The simulator's count of executed commands (1 780) is at most the number created, but it
  does not count replays separately, so "exactly once" is not demonstrated here, only "none lost". Agent-side idempotency is
  covered by its own tests.

R-121 therefore stays partial: loss of a replica is now run and nothing was lost, but it is one run on one host, with a
balancer that does not health-check, and without a duplicate check.
