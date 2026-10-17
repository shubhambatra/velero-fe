# Resilience (M7 day 39)

What the control plane does when things around it fail, how that was tested, and the two rotation procedures. Operators
will find the same steps in `docs/OPERATIONS.md` (day 43).

## What is tested, and how

`server/test/resilience.e2e.test.ts` puts PostgreSQL, Redis and the agent link behind a TCP proxy that can be cut
and restored (`test/chaos-proxy.ts`): every open connection is reset and new ones are refused until restored. That is the
same thing a restart or a partition does to a client, against the real services, with no root and no docker.

| Failure                            | Promise                                                                                                                                                                                                                                                                                  | Test                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| PostgreSQL goes away mid-command   | `/healthz` stays 200 and `/readyz` 503; users get **503 with `Retry-After`** (no stack, no driver text); the pool reconnects by itself; a command acked before the outage finishes exactly once when the agent repeats its result; a finished command never changes; one row per command | "survives a PostgreSQL outage"             |
| Redis goes away                    | Sessions live there, so nobody is let in (503, not 200); the process stays up; work created meanwhile is kept; the agent's stream is untouched and its results are applied after                                                                                                         | "survives a Redis outage"                  |
| Partition between agent and server | A command sent but unacked comes again after reconnect (at-least-once, `attempts` = 2), one issued during the partition arrives once, oldest first, nothing is invented; repeated acks and results change nothing                                                                        | "keeps a command through a partition"      |
| A slow agent                       | Only its own commands wait; another cluster is served in under a second; nothing resends on its own while the stream is up; past the deadline it is `TIMED_OUT` and a late result is ignored                                                                                             | "a slow agent holds only its own commands" |

Redelivery is deliberately at-least-once: the agent recognises a command by its id and does not run it twice (Go
dispatcher tests). The control plane's half is that the id never changes and the state never goes backwards.

Mutation checks done by hand: delivering twice on reconnect makes the partition test fail; accepting only the ACTIVE CA makes
the rotation test fail.

### Not tested

- **Loss of one replica** (R-121). The tests run one process. Cross-replica control goes over Redis and a stale-route sweeper
  exists (`streams.e2e`), but a real two-replica kill has not been run. Day 41 (Helm) is the place.
- A **real PostgreSQL or Redis restart** (container stop and start). The proxy reproduces what clients see, not server-side
  recovery such as WAL replay.
- **Transport backpressure** for an agent that stops reading (HTTP/2 flow control). "Slow" here means slow to acknowledge.
- Clock skew between agent and server.

## Rotating `VFM_MASTER_KEY` (G-9)

1. Generate a new 32-byte key. Set it as `VFM_MASTER_KEY` and move the old one to `VFM_MASTER_KEY_PREVIOUS`. Roll the replicas.
   Everything still opens (`createKeyring` accepts the previous key).
2. `node dist/rewrap.js --dry-run` shows, per column, how many values are still on an old key.
3. `node dist/rewrap.js` re-encrypts them under the new key. It reads and writes only the four encrypted columns
   (`users.mfa_secret_encrypted`, `certificate_authority.key_encrypted`, `oidc_providers.client_secret_encrypted`,
   `notification_channels.config_encrypted`), writes each value only if it is still the one it read, and can be run while the
   server is up and run again. Exit 1 lists any value it could not open (nothing is changed for those).
4. When a run reports `stale: 0` everywhere, remove the old key from `VFM_MASTER_KEY_PREVIOUS` and roll again.
5. Keep the old key backed up until a database backup taken before step 3 has aged out.

## Rotating the internal CA (G-12)

Agents already receive a PEM **bundle** at enrolment and with every renewed certificate (every 7 days at most) and the agent
keeps the whole bundle, so a second CA needs no protocol change and no re-enrolment (ADR-043).

1. `node dist/ca-rotate.js stage`: a new CA joins the bundle. Nothing signs with it, nothing can break. Undo with `unstage`.
2. Wait one agent-certificate lifetime (7 days): every connected agent has then renewed and trusts both CAs.
3. `node dist/ca-rotate.js promote`: the new CA signs from now on; the gateway reissues its own server certificate. The old CA is
   RETIRING, still trusted, so certificates it signed keep working. Replicas follow within 30 seconds, no restart needed.
4. Wait another lifetime, until everything the old CA signed has expired.
5. `node dist/ca-rotate.js retire`: the old CA is deleted.

`promote` and `retire` refuse before the wait is over. `--force` skips it for an operator who has checked another way, and is
logged at warning level. An agent that has been offline longer than a lifetime already has an expired certificate and must be
re-enrolled whatever the CA does. `ca-rotate status` prints each CA's state and fingerprint.

The CLIs log every step to stdout. They run as the operator on the host, outside the API, so they are **not** in the audit
log; keep their output with the change record.
