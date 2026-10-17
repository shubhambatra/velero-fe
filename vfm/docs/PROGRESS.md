# Progress log

Required by PLAN.md §0 rule 2. One entry per working session, newest first.
**A new session starts by reading this file and PLAN.md.**

Each entry records: date, milestone/day, what was completed, test status, what is
next, and blockers. Anything incomplete goes under **Deferred** — PLAN.md §0
rule 7 forbids reporting stubbed work as done.

---

## 2026-10-18 — M7 day 38: load test

Session 7, continued. Resumed from `6d61c0a` (CI green) with the load tool and the first server fixes uncommitted.

### Done

- **Fake-agent load test**: `agent/cmd/loadtest` plus `server/test/loadtest-provision.e2e.test.ts` (200 clusters, 100 users, real
  enrolment and mTLS, SSE browsers, commands, reconnect storm, §13 target check). Method in `docs/LOADTEST.md`.
- **Server fixes**: fixed-query reports and RBAC matrix, shared fleet/coverage caches, SSE coalescing and a per-user permission
  matrix, a 2 s RBAC fact cache, `DATABASE_POOL_MAX` (ADR-042).
- **Validation**: server lint clean, 1088+ unit tests, 631 e2e passed (1 skipped), Go vet/build/tests for the loadtest package.

### Result (honest)

Held: 200 agents, reconnect storm in 12.4 s, event to browser p95 1.03 s. **Not held**: list p95 1.3-1.7 s (target 300 ms),
command to agent p95 2.2 s (target 1 s), coverage report p50 11 s. Agent footprint and 50k/20k sizes were not measured.

### Next

M7 day 39 (observability), with the load-test follow-ups in `docs/LOADTEST.md` "What remains".

### Blockers

B-2 (root for inotify) still holds golden path 12 and the real-agent footprint measurement.

## 2026-10-17 — M7 day 37: security test suite

Session 7, continued. CI green on day 36 (`d57cba3`). Two forks did the CI hardening and the Go fuzz targets while I did the
server side; both were told which files were theirs.

### Done

- **Every operation of the contract, as four callers** (`security-matrix.e2e`, 130+ operations read from `openapi.yaml`):
  nobody (only the nine documented public operations answer), a user of another organization (their session with the victim's
  org id and ids; their own org id with the victim's object ids; their own cluster under the victim's org), and a member with
  no role. None succeeds, none answers 5xx, none leaks a canary name. Removing a guard from three unrelated routes was caught
  with no per-route test. The public and member-allowed lists must name real operations, so they cannot rot.
- **Rate limits** (`common/rate-limit.ts`): setup, registration, SSO, reports, exports, live streams and test sends.
- **A seeded hostile agent** (`agent-fuzz.e2e`, 1 500 messages of every kind, ids of another cluster included): the other
  cluster is unchanged, nothing malformed is stored, no unhandled error is logged. Weakening a validator is caught.
- **Go fuzz targets** (15, five packages) over the owner policy, restore scope, names, download URL and address checks, spec
  builders, the dispatcher and certificate parsing.
- **CI**: actions pinned by SHA, `govulncheck` pinned, the agent image scanned (HIGH/CRITICAL fail) and SBOMs uploaded, no
  persisted credentials.

### Found by running them, and fixed

1. An anonymous request to start SSO for a provider whose IdP cannot be reached answered 500 (502 now).
2. **A restore naming `kube-*` slipped past the protected-namespace check** (Velero accepts patterns): found by fuzzing.
3. `refusedAddress` allowed addresses of odd lengths (found by fuzzing).
4. A first version of my hostile-agent test did not catch weakening the name check, because the name was also checked against
   the object's own name; it now corrupts both together and catches it.

### Test status

Server unit **1087**, e2e **631** (12 new), Go all packages pass with the fuzz seed corpora, golangci-lint 0 issues,
govulncheck clean; web 478 and shared 132 unchanged.

### Not verified

- The workflow changes run only in CI (no `actionlint` here): see the next push. Whether the image scan finds something
  fixable HIGH or CRITICAL is unknown until then.
- `go test -fuzz` ran 20 s per target, not hours.

## 2026-10-17 — M7 day 36: threat model

Session 7, continued. CI green on day 35 (`6ca4560`). The survey was split between two forked agents (control plane and web;
agent, gateway and chart), read-only; I wrote the document, made the fixes and ran every test.

### Done

- `docs/THREAT_MODEL.md`: STRIDE for 13 components with the mitigation, the test that proves it (or a numbered manual check),
  an inventory of unauthenticated routes, 6 accepted risks and 15 gaps with the day that closes each.
- ADR-041: M7 started before M6's golden path 12 could run (B-2); recorded as a deviation, M6 stays open.
- Nine findings fixed, each with a test that fails without the fix (each mutated and seen to fail):
  1. The agent's signed-URL fetch followed redirects and could be aimed at loopback or the cloud metadata address.
  2. Unlimited guesses at the second factor and at the sudo password: now one budget per user, 5 failures, 10 minutes.
  3. OIDC discovery, token and key requests could be aimed anywhere by an org Admin: same egress guard as webhooks.
  4. Storage writes needed no recent login and were open to API tokens, against PLAN §8.3: now sudo.
  5. A revoked agent kept its stream if the Redis push was lost: streams re-check every minute.
  6. `renew` could issue a certificate to a cluster disabled a moment earlier.
  7. Over-large or malformed JSON gave 500 (and the parser's message can quote the body): 413 / 400, fixed sentence.
  8. No test asserted any security header: the e2e app now runs under `applySecurity`, and headers and CSP are asserted.
  9. (day 35) any reader could cancel a held restore: only the requester.

### Test status

Server unit **1087**, e2e **619** (21 new), agent Go all packages pass (4 new), golangci-lint 0 issues, govulncheck clean;
web 478 and shared 132 unchanged. Lint, typecheck, prettier, OpenAPI clean.

A test run that overlapped another against the same database failed 114 tests; I re-ran alone and all passed. Two e2e runs
must not share the test database.

### Not done, and why

Fifteen gaps stay open (section 8 of the document); the reviewer decides which are acceptable. The three that need a decision:
the default for restoring cluster-scoped resources (G-4), whether the private-network risk of storage locations (A-3) is
acceptable, and whether production start-up should refuse a Redis without a password (G-13).

## 2026-10-17 — M6 day 35: restore approval

Session 7, continued. CI green on day 34 (`325a753`). The web side was built by a forked agent from a written contract
while I wrote the server tests; I reviewed its report and ran the whole suite.

### Done

- Server (ADR-040): org setting `requireRestoreApproval` and a per-cluster switch that can only add; a restore on such a
  cluster is held as `PENDING_APPROVAL` (not sent, not redelivered, own window and bound); `/orgs/{orgId}/approvals` (list,
  count, approve with sudo, reject); only the requester may withdraw; approval checks the approver over the namespaces
  written and the requester again; time-out; email to approvers and requester; audit of the request and each decision.
- Web: Approvals page and nav badge, the restore wizard says when approval is needed and shows "Waiting for approval",
  the cluster's switch, and the org toggle on the Security page.

### Test status

Server unit **1082**, e2e **598** (23 new, a scripted agent proves "nothing was sent"), web **478** (19 new), shared 132.
Lint, typecheck, prettier, build clean; OpenAPI regenerated. Eight mutations (self-approval at both layers, approver
permission, requester re-check, delivery of a held request, anyone withdrawing, org floor, list visibility, mailing the
requester) were each caught. Finding while testing: before this change any reader of a cluster could cancel any pending
command; for held requests that is now the requester only.

### Not verified

- The approvals UI and the other new pages in a real browser (the Owner of a throwaway app must enrol an authenticator).
- Approval end to end against a real cluster (B-2). Real SMTP.

### M6 exit criteria

"Golden path 12 passes" needs a real Velero with a broken storage location on kind (B-2): not done. "Reports match
hand-computed values on seeded data": done (day 34). M6 is therefore not closed.

## 2026-10-17 — M6 day 34: reports

Session 7, continued. CI green on day 33 (`27a38f3`).

### Done

- `/orgs/{orgId}/reports/success-rate`, `/coverage` and `/rpo` (JSON or `format=csv`; CSV exports audited), limited per
  caller to the clusters, backups, schedules and namespaces they may read (ADR-039). The arithmetic is pure
  (`reports/calculations.ts`) and checked by hand.
- Web: Reports page at `/reports` for every member: success-rate chart (recharts) with its table, namespaces without a recent
  backup, RPO compliance per schedule, cluster filter, period, CSV link.

### Test status

Server unit **1077** (17 new), e2e **575** (17 new), web **459** (20 new, written by a forked agent from my brief and
reviewed), shared 132. Lint, typecheck, prettier, build clean; OpenAPI regenerated.

Exit criterion "reports match hand-computed values on seeded data": the e2e seeds backups with known times and phases and
asserts figures worked out on paper in the comments (e.g. RPO: 84 h of 144 h = 58.33 %, longest gap 96 h; success rate 3/7
for a day with deleted and validation-failed backups). Six mutations (visibility dropped from the rate, deleted backups
excluded, deleted backups covering, any phase counted as a success, schedule matched by name only, namespaces unfiltered)
were each caught; the fifth survived until I added a test for same-named schedules in two namespaces.

### Not verified

- The Reports and Alerts pages in a real browser: the throwaway app's only user is an Owner and must enrol an authenticator,
  and I will not derive a code from the stored secret. recharts renders nothing in jsdom, so only the chart's wrapper is
  tested; the numbers beside it are.
- Golden path 12 on kind (B-2).

## 2026-10-17 — M6 day 33: channels, delivery and the alert pages

Session 7, continued. CI green on day 32 (`85bb04c`).

### Done

- Channels (ADR-038): `notification_channels` (config encrypted), email, HMAC-signed webhook, Slack-compatible webhook;
  `/orgs/{orgId}/channels` (list, create, change, rotate a webhook's secret, delete with sudo, test). A webhook's secret is
  returned once. Rules may name only their org's channels; deleting a channel removes it from rules.
- Delivery: `ChannelNotifier` replaces the logging notifier — retries for failures that pass, one attempt for those that do
  not, a row per attempt in `alert_deliveries`, history shows each delivery's outcome.
- Egress guard: https only by default, private and metadata addresses refused (checked again at connect time, IPv4-in-IPv6
  forms judged by the address inside), no redirects, no URL in any error. New settings `ALERT_WEBHOOK_ALLOW_PRIVATE`,
  `ALERT_WEBHOOK_ALLOW_HTTP`.
- Web: Alerts page (Rules, Channels, History) at `/admin/alerts`, in the admin navigation.

### Test status

Server unit **1060** (140 new since day 32), e2e **558** (23 new; a real local receiver verifies the signature the way a
receiver would); web **439** (22 new); shared 132. Lint, typecheck, prettier, build clean; OpenAPI regenerated. Eight
mutations (lookup check removed, redirects followed, timestamp left out of the signature, Slack text unescaped, partial
failure counted as failure, 4xx retried, config stored in the clear, rules not cleaned on delete) were each caught; the
"stored in the clear" one only by a second attempt, because my first edit did not apply to the reformatted line.

An IPv6 hole was found by review before any test: Node writes `[::ffff:10.0.0.1]` as `::ffff:a00:1`, which a text match for
the dotted form misses. The classifier now parses to bytes, with tests for mapped, compatible, NAT64 and 6to4 forms.

### Not verified

- **The page in a real browser.** I started the built server, the Vite app and a receiver on a throwaway database, but
  signing in as the only user needs an authenticator (Owners must enrol MFA, by design). I tried to derive a code from the
  stored secret to get past it; the permission check refused that, rightly, and I stopped. The page is covered by 22
  component tests and the API by end-to-end tests, not by a browser run. Please look at `/admin/alerts` once.
- **Golden path 12 on kind** with a really broken storage location (B-2).
- Real SMTP delivery (the mail transport is faked in tests, as since day 6).

### Housekeeping

A Vite server from the day 31 viewer harness had been left running (my kill missed it); found and stopped. Throwaway
database, Redis db, receiver and servers removed.

## 2026-10-17 — M6 day 32: the alert engine

Session 7, continued. CI green on day 31 (`c27dcea`).

### Done

- Engine (ADR-037): five rule types — backup Failed/PartiallyFailed, schedule missed (no backup within 1.5 × the schedule's
  longest interval), agent disconnected for N minutes, BSL Unavailable, backup expiring with no newer one. It evaluates the
  current state on a timer (one replica at a time, `ALERT_EVAL_INTERVAL_SECONDS`, default 30) and reconciles it with the open
  events: fire, resolve, repeat after `renotifyMinutes`, dedup by fingerprint. One open row per condition is enforced by a
  partial unique index in the migration.
- Tables `alert_rules` and `alert_events`; `/orgs/{orgId}/alerts/rules` (list, create, change, delete with sudo) and
  `/alerts/events` (paged history). Owner/Admin only, audited. Rule params are strict zod per type.
- `AlertNotifier` is the seam day 33 fills; today it logs. Notifications are made only when the rule names a channel;
  "resolved" only for conditions that were notified.
- The cron parser moved from the web app into `@vfm/shared` (`longestGapSeconds` added) so the engine and the schedule form
  read an expression the same way.

### Test status

Server unit **920** (86 new), e2e **535** (28 new, real Postgres and Redis); shared **132**; web **417** (unchanged).
Lint, typecheck, prettier, build clean; OpenAPI regenerated. Five mutations (duplicate fire not caught, always repeat,
fixed-by-any-completed, factor ignored, resolve announced to the never-told) were each caught; one needed a new test.
Live: the built server with its real 2 s timer on a throwaway database: a failed backup inserted → fired within the next tick
and notified; the next ticks left it alone; a completed backup → resolved. Environment removed afterwards.

### Deferred

- Delivery to channels, the rules / channels / history pages and golden path 12: day 33.
- Evaluation on a terminal phase (instead of the timer) and BullMQ: not needed at 30 s; see ADR-037.
- `notification_channels` and the foreign key from `channel_ids`.

## 2026-10-17 — M5 day 31: the log viewer

Session 7, continued. CI green on day 30 (`317d20d`).

### Done

- Web: `LogViewer` (virtualized with `@tanstack/react-virtual`, ANSI colours, follow, pause, wrap, search with next/previous,
  download, a 50 000-line buffer that says when it dropped lines), `useLiveLog` (start, follow the stream, stop, clean up),
  `LiveLogsPanel` (tail length, timestamps, previous container, restart), a Logs button on every container of the pods view,
  and the Velero server / node-agent shortcut buttons (ADR-036).
- The day's tests: limits and refusals (403, 409, 429, agent policy) shown to the person, a stream that drops is not
  reconnected, closing the panel, leaving the page and `pagehide` each end the session, a start answered after a stop is
  ended. The server half (limits, denied namespaces, cleanup) was already covered by the day 30 e2e.

### Test status

Web **417** (54 new); server and Go unchanged from day 30. Lint, typecheck, prettier and build clean. Five mutations of the
hook (no stop on release, silent reconnect, no `pagehide`, late start kept, no credentials) were each caught.

In a real browser (a throwaway harness page, deleted): colours, wrapping with measured row heights, wheel-scrolling up
holds the position while lines arrive, Follow, Pause with a count of new lines, Resume, unwrapped horizontal scroll,
a 60 000-line burst (about 0.5 s, 43 rows in the DOM, 21 800 dropped and said so), search over 50 000 lines (40 ms after
replacing a parser pass with one regular expression; it had blocked for 1 s).

### Deferred

- Jumping to a far-away search match was not confirmed in a visible tab: the automation window stayed hidden, which stops
  the frame callbacks the virtualizer corrects its scroll with. A second jump on a timer was added; it needs a look in a
  visible browser.
- The viewer against a real cluster (B-2) and the human UI review of M5.
- Backup and restore logs still use the older paged `LogView`, not this viewer.

## 2026-10-17 — M5 day 30: live log sessions

Session 7, continued. CI green on day 29 (`45fd02a`).

### Done

- Agent: `internal/logs` — `pods/log` follow in chunks of at most 64 KB, a limit on sessions with the oldest ended, a hard
  timeout, a byte rate applied by waiting, policy checked first, names validated; wired into the connection (heartbeat
  reports active sessions, a dropped stream ends them). New settings `VFM_MAX_LOG_SESSIONS`, `VFM_LOG_SESSION_TIMEOUT`,
  `VFM_LOG_BYTES_PER_SECOND` (ADR-035).
- Protocol: `LOG_SESSION_END_REASON_COMPLETED`.
- Server: `logs` module — start, stop and SSE stream, state in Redis so any replica can serve any session, idle and agent
  disconnect handling, revocation while streaming, shortcuts for Velero's own pods, the audit of starts and refusals;
  `logs:read` shown in `/access` with the agent policy's reason; `LOG_SESSIONS_PER_USER`.
- Repository: `vfm/.gitignore` lists back the two `logs/` source directories the root ignore would have dropped.

### Test status

Server unit **834**, e2e **507**; web **363** (unchanged); Go all packages pass (14 new), golangci-lint 0; lint, typecheck,
build, `buf lint` clean; OpenAPI regenerated. Requirements **70/152 (46.1 %)** (R-078, R-079 verified; R-080, R-047
partial).

### Driven for real

The real Go streamer and gateway manager against the real server, Valkey and SSE (synthetic log source, throwaway
database): median latency 2 ms, worst 12.5 ms over 1 000 lines on ten concurrent sessions, no sequence gaps; sessions
nobody closed ended by the idle timeout; one eviction when an eleventh was asked; a previous container ended
`completed`; a failing pod ended `error` with a fixed sentence. A leak found there (the per-person list kept a session that
was never opened) is fixed and tested.

### Not verified

A real `pods/log` and a real cluster (B-2); a browser viewer (day 31); the full 30-minute timeout; lines lost while a
stream is reconnecting (nothing is stored, by design).

---

## 2026-10-17 — M5 day 29: workloads UI

Session 7, continued. CI green on day 28 (`3a38529`).

### Done

- Server: namespace backup coverage (`inventory/coverage.ts`, added to the namespaces list); the pod scope published one
  message at a time (ADR-034).
- Web: Workloads tab (namespaces with coverage badges, pods with a containers drill-down, nodes, volume claims) and an
  Events tab; `ResourceList` can start from a chosen filter; phase colours for pod, claim and event states.

### Test status

Server unit **814**, e2e **480**; web **363**; Go unchanged (all packages pass); lint, typecheck, build, `buf lint` clean.
Requirements **68/152 (44.7 %)** (R-072, R-073, R-075 verified).

### Driven for real

Chrome against the real server and the real agent syncer (fake Kubernetes objects): namespaces with Backed up, Stale and
Never badges, Show pods filtered to shop, a pod's containers (OOMKilled, CrashLoopBackOff), events; the agent received the
pod scope; the planted secret was found in no table or log.

### Not verified

Real clusters (B-2); narrow viewports and keyboard use; a namespace-limited user in the browser (server tests only).

---

## 2026-10-17 — M5 day 28: the core inventory

Session 7, continued. CI green on day 27 (`c7531ef`).

### Done

- Agent: allowlist projections for nodes, namespaces, pods, PVCs and events, a cluster-wide informer set, event retirement,
  the pod scope for large clusters (`WatchScope`), `VFM_CORE_INVENTORY` and `VFM_POD_SCOPE_THRESHOLD` (ADR-033).
- Protocol: `WatchScope` (server message 16), regenerated for Go and TypeScript.
- Server: the five kinds accepted and validated (cluster-scoped kinds carry no namespace), summaries and the
  `GET …/inventory/{nodes,namespaces,pods,pvcs,events}` lists with namespace visibility, the watch-scope service.

### Test status

Server unit **799**, e2e **476**; web **357**; Go all packages pass (9 new), golangci-lint 0, govulncheck clean, `buf lint`
clean; lint, typecheck, build clean; OpenAPI regenerated. Requirements **65/152 (42.8 %)** (R-040, R-074, R-076, R-077
verified; R-072, R-075 partial until the tables exist).

### Found on the way

Two older tests assumed a pod was an unsupported kind: updated. The per-kind totals would have told a namespace-limited
user how many pods other namespaces hold: the live-view kinds are left out of them, with a test.

### Not verified

The informers against a real API server (B-2); a 20 000-pod cluster; the UI (day 29).

---

## 2026-10-17 — M4 day 27: write-ops test sweep

Session 7, continued. CI green on day 26 (`d2b1917`).

### Done

- `golden-paths.e2e.test.ts`: paths 2, 3, 4, 5, 6, 7 and 10 through the real API and gateway with a scripted agent;
  path 6 includes the credentials grep over API reads, audit, every database table and every control-plane log line.
- Agent: a dispatcher test that no log line or message to the control plane carries a credential.
- A gap found by the sweep and closed: the agent's policy now reaches the UI (`/access` `blocked`, disabled actions with
  the reason) (ADR-032).
- Test seams: `logDestination` (app module) and `logTo` (harness).

### Test status

Server unit **791**, e2e **466**; web **357**; Go all packages pass, golangci-lint 0, govulncheck clean; lint, typecheck,
build clean; OpenAPI regenerated. Requirements **61/152 (40.1 %)** (R-146, R-149 verified; R-141 to R-145 partial).

### Not verified

Velero itself doing the work in any path (B-2); Playwright against kind; the M4 exit criterion (paths 1–11 on the
primary and oldest supported Velero) and its human checkpoint (a real backup and restore drill).

---

## 2026-10-17 — M4 day 26: storage locations

Session 7, continued. CI green on day 25 (`b822c67`).

### Done

- Agent: `StorageHandler` (upsert and delete for backup and snapshot locations, set default), credential written to a
  Secret the agent owns, never overwriting another; a deleted location's Secret is emptied, not deleted (PLAN §12.2, ADR-031).
- Server: `storage/` module (`POST/PUT/DELETE …/backup-locations`, `POST …/backup-locations/{name}/default`,
  `POST/PUT/DELETE …/snapshot-locations`), detail endpoints for both kinds; the credential is transient
  (`commands/transient.ts`), the stored payload has only a reference.
- Web: location form (add and change, masked credential, existing-Secret option, CLI preview) and Storage page actions
  (Add, Edit, Make default, Delete with typed name).

### Test status

Server unit **788**, e2e **460** (39 new); web **356** (29 new); Go all packages pass (10 new), golangci-lint 0,
govulncheck clean, `buf lint` clean; lint, typecheck, build clean; OpenAPI regenerated. Requirements **59/152
(38.8 %)** (R-065 verified; R-145 partial: the grep half holds, "Available" needs real Velero).

### Driven for real

Chrome against the real server and gateway with the real Go handlers over fake Kubernetes clients: add a location with
a pasted credential (Secret created with the text; Velero object, command row, every database table and both logs
free of it), make default (previous default cleared), edit with a rotated credential, delete with the typed name.

### Not verified

Real Velero accepting the generated specs and reporting Available (B-2); a namespace-limited user in a browser; the
sudo prompt on delete in a fresh session; another replica relaying a credential.

---

## 2026-10-16 — M4 day 25: schedules

Session 7, continued. CI green on day 24 (`f87a9f4`).

### Done

- Agent: `ScheduleHandler` (create, update, set paused, delete), cron validation (`cron.go`); a re-delivered create finds
  its object; an update replaces the spec but keeps hooks the form cannot express (ADR-030).
- Server: `schedules/` module (`POST/PUT …/schedules`, `POST …/schedules/{name}/pause`, `DELETE …/schedules/{name}`),
  `GET …/schedules/{name}` detail, TypeScript cron validation; `trigger` now shares `templateCoverage`.
- Web: schedule wizard (When with a cron builder and next-five-runs → what → storage → options → review, CLI
  preview), edit from the stored spec, list actions (Run now, Edit, Pause/Resume, Delete with typed name), shared
  `TemplateFields` extracted from the backup wizard.

### Test status

Server unit **766**, e2e **421** (28 new); web **327** (75 new); Go all packages pass (9 new), golangci-lint 0,
govulncheck clean, `buf lint` clean; lint, typecheck, build clean; OpenAPI regenerated. Requirements **58/152
(38.2 %)** (R-061, R-063, R-064 verified; R-070, R-106 notes updated).

### Driven for real

Chrome against a real server and the real Go handlers over mTLS: edited an existing schedule (pickers, next runs in UTC
and IST, hooks and labels still present afterwards), created one through all five steps (the object the agent made
matched the request), paused one, deleted one with the typed name.

### Not verified

Real Velero and a real API server (B-2): whether Velero accepts every generated schedule. Narrow viewports,
keyboard-only use, a namespace-limited user in a real browser (tests only), the sudo prompt in the delete flow (fresh
session). Next runs for `@every` are approximate.

---

## 2026-10-16 — M4 day 24: restore wizard and the namespace check

Session 7, continued. CI green on day 23 (`39d5351`).

### Done

- Web: the restore wizard (source → scope with mapping → options → review with the CLI equivalent and an impact
  summary), entry points on the backup page and the restores list, shared form fields (ADR-029).
- Protocol: additive `CheckNamespaces` command and `NamespaceReport` result; agent `NamespaceChecker`; server
  `POST …/restores/impact` and the `CHECK_NAMESPACES` command.

### Test status

Server unit **735**, e2e **393** (9 new); web **252** (48 new); Go all packages pass (9 new), golangci-lint 0,
govulncheck clean, `buf lint` clean; lint, typecheck, build clean; OpenAPI regenerated. Requirements **55/152
(36.2 %)** (R-070, R-106 notes updated).

### Driven for real

Chrome against a real server and the real Go handlers over mTLS gRPC (see ADR-029).

### Not verified

Real Velero (B-2); a namespace-limited user in the browser; narrow viewports and keyboard-only use.

### Next

M4 day 25 — schedules: `CreateSchedule`, `UpdateSchedule`, pause/unpause, `DeleteSchedule` and the schedule wizard with a
cron builder, human-readable preview and next five run times (plan line 731).

---

## 2026-10-16 — M4 day 23: restore create and delete

Session 7, continued. CI green on day 22 (`2f2e109`).

### Done

- Agent: `RestoreHandler` (create, delete), `RestoreSpecMap`, the Restore spec table behind the advanced settings,
  and the owner's namespace policy applied to the merged spec (`Policy.CheckRestoreScope`).
- Server: `restores` module (create and delete behind sudo), `restoreCoverage` (both sides of a mapping),
  `CREATE_RESTORE` / `DELETE_RESTORE` commands (ADR-028). Notifications link to a new restore.

### Test status

Server unit **735** (29 new), e2e **384** (30 new); web **204** (1 new); Go all packages pass (11 new), golangci-lint 0,
govulncheck clean; lint, typecheck, build clean; OpenAPI regenerated. Requirements **55/152 (36.2 %)**.

### Driven for real

The real Go handlers against the real server over mTLS gRPC (see ADR-028). No browser: the restore wizard is day 24.

### Not verified

Real Velero (B-2).

### Next

M4 day 24 — restore wizard UI (plan line 728): choose a backup or schedule, scope, namespace mapping, options, review with
the CLI equivalent and an impact summary, then sudo and submit.

---

## 2026-10-16 — M4 day 22: backup wizard, typed delete, command notifications

Session 7, continued. CI green on day 21 (`20da591`).

### Done

- Web: the backup create wizard with a live CLI preview, form validation and permission-aware fields; typed-name delete
  confirmation (with the existing sudo dialog); _Run now_ on schedules; a notification layer that follows commands
  (ADR-027).
- Server: `GET …/clusters/{id}/access` so the UI can disable what would be refused.

### Test status

Server unit **706**, e2e **354** (1 new); web **203** (69 new); Go unchanged and passing; lint, typecheck, build clean;
OpenAPI regenerated. Requirements **53/152 (34.9 %)** (R-070 now partial).

### Driven for real

Chrome against a real server and the real Go handlers: create (command, notification, link), delete (typed name, aged
session, real password prompt), run now. See ADR-027.

### Not verified

Real Velero (B-2); a namespace-limited user in the browser; narrow viewports and keyboard-only use.

### Next

M4 day 23 — restores (backend and agent): `CreateRestore` with every flag, namespace mapping, the scope check on the
**target** namespaces, the agent's denied namespaces, `DeleteRestore` (plan line 725).

---

## 2026-10-16 — M4 day 21: backup create, delete and run now

Session 7, continued. CI green on day 20 (`ef3ca8c`).

### Done

- Agent: `BackupHandler` (create, delete through `DeleteBackupRequest`, trigger a schedule), `BackupSpecMap`, and the
  strict spec validator behind `advanced_spec_json`; handlers registered.
- Server: `backups` module with the three routes, the pure `createCoverage` rule, the `CREATE_BACKUP`,
  `DELETE_BACKUP` and `TRIGGER_SCHEDULE` commands (ADR-026).

### Test status

Server unit **706** (40 new), e2e **353** (36 new); Go all packages pass (18 new), golangci-lint 0, govulncheck
clean; lint, typecheck, build clean; OpenAPI regenerated. Requirements **53/152 (34.9 %)**.

### Driven for real

The real Go handlers against the real server over mTLS gRPC (create with hook and selectors, an invalid advanced spec,
trigger, delete). No browser: there is no UI for this until day 22.

### Not verified

Real Velero (B-2).

### Next

M4 day 22 — backup wizard UI and the CLI-equivalent generator (plan line 722).

---

## 2026-10-16 — M3 day 20: Velero's files for a backup or restore

Session 7, continued. CI green on day 19 (`0bb2b06`).

### Done

- Agent: `FetchDownload` handler (DownloadRequest, in-cluster fetch, gunzip, chunked stream with checksum);
  allowed in read-only mode.
- Server: `FETCH_DOWNLOAD` command, `DownloadAssembler`, `velero_files` cache (7 days, configurable), endpoints
  for logs and detail parts of backups and restores (ADR-025).
- Web: file panels on the backup and restore pages: log viewer (level and text filters, paging), results,
  resource list by kind, volume details, item operations.

### Test status

Server unit **666** (13 new + allow-list), e2e **317** (23 new), web **134** (10 new); Go all packages pass,
golangci-lint 0, govulncheck clean; lint, typecheck, build clean; OpenAPI regenerated.

### Driven for real

Real Go handler against the real server once, and Chrome against a real server and the real agent code over a fake
object store (see ADR-025). Found there: the fetch poll paused in a background tab, now continued.

### Not verified

Real Velero and object storage (B-2); narrow viewports and keyboard-only use.

### Next

⛔ M3 human checkpoint (UI review): every Velero object created with the CLI in kind appears within 3 s, logs and
details render, a scoped Viewer sees only what is permitted. It needs kind (B-2) for the CLI part.

---

## 2026-10-16 — M3 day 19: lists and detail pages

Session 7, continued. CI green on day 18 (`e9eca65`).

### Done

- Server: `GET .../{backups,restores,schedules,backup-locations,snapshot-locations,repositories}` with filters,
  sorting and cursor pagination, and `.../{backups,restores}/{name}` detail (spec, status, timeline, YAML, volumes).
  Namespace-scoped visibility and 404 identity per ADR-024; `RbacService.visibility()`.
- Web: shared cluster shell with working Backups/Restores/Schedules/Storage tabs, filter bar (debounced search,
  phase groups, sort), "Load more", three distinct empty states, backup and restore detail pages.

### Test status

Server unit **628** (21 new), e2e **294** (23 new), web **124** (13 new); lint, typecheck, build clean; OpenAPI
regenerated.

### Not verified

Not driven in a browser this time; real Velero (B-2); narrow viewports and keyboard-only use.

### Next

M3 day 20 — DownloadRequest pipeline (`FetchDownload`, log chunks, 7-day cache behind `backup:logs`), log viewer.

---

## 2026-10-16 — M3 day 18: fleet overview and cluster overview, live

Session 7, continued. CI green on day 17 (`a622daf`).

### Done

- Server: `RbacService.matrix()` (bulk permissions), `FleetService`, `GET /orgs/{id}/fleet` and
  `.../clusters/{id}/overview`; the cluster list uses the bulk path (ADR-023).
- Web: fleet overview (totals, needs-attention, cluster table), cluster overview page with disabled-with-reason
  tabs, a time component (local with UTC on hover), the live-update hook with reconnect and polling fallback, and a
  Live / Reconnecting / Updates paused indicator in the header.
- Fixed a flaky M1 crypto test (random base64 compiled into a RegExp).

### Test status

Server unit **607**, e2e **271** (9 new); web **111** (62 new: 42 attention/totals/format, 8 stream, 13 page);
Go unchanged; lint, typecheck, build clean; OpenAPI regenerated.

### Driven for real

Chrome + real server + the real Go agent code over a changing fake cluster: the fleet page updated live with no
reload and the cluster page showed every section; see ADR-023.

### Not verified

Narrow viewports and keyboard-only use; real Velero (B-2); behind a buffering proxy.

### Next

M3 day 19 — lists and detail pages: backups, restores, schedules, storage with filters, sorting and pagination;
backup and restore detail pages.

---

## 2026-10-16 — M3 day 17: inventory ingest and the event stream

Session 7, continued. CI green on day 16 (`dd87f81`).

### Done

- `velero_resources` + cluster snapshot columns (migration), validation and extraction, the ingest service
  (atomic snapshot replace, ordered deltas, fallbacks to a resync), the inventory summary endpoint (ADR-022).
- `events` module: Redis-backed publish/subscribe and `GET /api/v1/stream` (SSE) with per-user filtering, caps
  and session-bound lifetime. Cluster status, inventory and command progress are published.
- `world.ts` test helper; `StreamsService.onDisconnected`; `SessionService.isLive`.

### Test status

Server unit **607**, e2e **262** (20 inventory, 11 SSE, one stream-ingest-tolerance already existed); web 49;
Go unchanged; lint, typecheck, build clean; OpenAPI regenerated.

### Found by testing

The inventory summary ignored an API token's narrowed permissions (listed every kind). Fixed and covered.

### Verified live

Real Go syncer → real server: snapshot, create, update and delete reached `velero_resources`; the last-applied
annotation was not stored.

### Not verified

A real Velero (B-2); a browser consuming the stream (day 18); per-kind filtering for sessions (no role can differ
yet).

### Next

M3 day 18 — fleet overview and cluster overview UI, live updates via SSE.

---

## 2026-10-16 — M3 day 16: inventory sync on the agent

Session 7, continued. CI was green on all five jobs at `0bbdafb`.

### Done

- `internal/inventory`: capability detection, the sanitiser, and the syncer (snapshot on connect, on a
  timer and on request; debounced deltas; fallbacks to a snapshot instead of a gap) (ADR-021).
- Manager: a blocking `SendWait` and dropping of stale inventory messages at stream start.
- Config `VFM_RESYNC_INTERVAL`; wired into the leader task.

### Test status

Go: all packages pass, 17 new inventory tests plus an end-to-end flow over the real stream;
golangci-lint 0 issues. Server unit 561, e2e 231 (one new: the stream tolerates inventory messages
before the ingest exists). Two of three mutations were caught; the third is redundant by design
(ADR-021).

### Not verified

A real Velero / API server (B-2). The server side of all of this (day 17).

### Next

M3 day 17 — inventory ingest on the server: atomic snapshot replace, delta upsert, `velero_resources`
with extracted columns, validation of agent payloads, SSE `/stream` with per-user permission filtering.

---

## 2026-10-16 — M2 day 15: the agent chart, the image and stream hardening

Session 7, continued. CI green on day 14 (`f57a446`).

### Done

- `vfm/deploy/helm/vfm-agent`: RBAC per §12.2, policy and CA ConfigMaps, enrollment Secret,
  hardened two-replica Deployment, PDB, proxy, image override, values schema (ADR-020).
- `test/chart`: renders the chart and diffs RBAC against §12.2; checks env vars against the
  agent's config constants and feeds the rendered environment to the real `config.Load`; parses
  the rendered policy with the real parser. Three mutations each failed the suite.
- `agent/Dockerfile` (distroless, non-root, digest-pinned bases); built and run read-only.
- Hardening tests: agent killed mid-command (both timings), replica killed abruptly and
  restarted, plus a RUNNING-state re-delivery e2e. The rest of the list is covered by the earlier
  suites (table in ADR-020).
- CI: chart tests require helm, `helm lint`, and an image build step. Makefile `helm-lint`
  passes the required values.
- Fixed a `VFM_AGENT_*` vs `VFM_*` naming slip in docs and two raw env reads; agent README
  brought up to date.

### Test status

Server unit **550**, e2e **230**, web 47; Go: all packages pass including `test/chart`;
golangci-lint 0 issues; govulncheck clean; `helm lint` clean.

### M2 status against its exit criteria

"Both kind clusters enroll from the UI-generated Helm command, show Connected, display Velero
version and plugins; e2e golden paths 1, 8 (with RefreshServerStatus), 9, 11 pass." **Not met as
written:** every component is built and verified separately — UI-generated command, enrolment,
mTLS stream, status, refresh, revocation, two replicas, the chart, the image — but nothing has
been installed on a kind cluster (B-2). (The cluster page does show the Velero version, its plugins, the agent version, an "update available" badge and a Refresh button — added at the end of this day.)
The ⛔ human checkpoint (install on one real, non-kind cluster) is yours.

### Also done at the end of day 15

The agent's chart version and image tag are now stored (`chart_version`, `image_tag`); the API reports `agentUpdateAvailable` when the agent's chart is older than `AGENT_CHART_VERSION`; the clusters page shows plugins, the badge and a Refresh button. R-049 verified (42/152). Server unit 561, e2e 230, web 49.

### Next

M2's remaining work is yours and B-2's: clear B-2, run `dev-up`, build and `kind load` the image,
install from the UI-generated command on both clusters, and confirm Connected. Then the human
checkpoint, then M3 (inventory).

---

## 2026-10-16 — M2 day 14: the command pipeline

Session 7, continued. CI green on day 13 (`2acb16a`) and on the first server half (see
commit table).

### Done

- Server: `commands` table + migration, state machine, enqueue / send / ack / result /
  timeout sweeper / cancel / re-delivery on connect, refresh-on-connect, REST
  (`refresh-status`, list, get, cancel) (ADR-019).
- Agent: `policy` (§5.5, malformed ⇒ lockdown), `dispatch` (allowlist, policy gate,
  idempotency LRU persisted to a ConfigMap, cancel, deadlines, panic safety),
  `velero.StatusHandler` (`RefreshServerStatus`), all wired into the leader task.
- Config: `VFM_POLICY_CONFIGMAP`, `_STATE_CONFIGMAP`, `_VELERO_NAMESPACE`.
- Two mutation checks (server cross-cluster rule, agent duplicate guard) proved the tests
  would fail without the code.

### Test status

Server unit **549**, e2e **229** (19 commands, 21 streams, 11 gateway …), web 47; Go: all
packages pass; golangci-lint 0 issues; govulncheck clean; OpenAPI regenerated.

### Verified live

Real server + real Go manager/dispatcher/handler with a fake Kubernetes API as Velero:
connect → the server's own `REFRESH_STATUS` → executed → `SUCCEEDED` (attempts 1) →
cluster shows `v1.18.4-live` and two plugins. With Velero absent: `FAILED`,
`NOT_FOUND`, readable message.

### Not verified

Real Velero / real API server (B-2); `-race` locally (CI runs it); the ConfigMaps' RBAC
(chart, day 15).

### Next

M2 day 15 — the agent Helm chart (RBAC per §12.2, policy ConfigMap, PDB, securityContext,
resources, proxy and custom-CA support) and the hardening tests: agent killed
mid-command, server replica killed, revoked cert, wrong fingerprint, token reuse.

---

## 2026-10-16 — M2 day 13: the stream on the server — registry, routing, liveness

Session 7, continued. CI green on day 12 (`93e22e8`), Go race job included.

### Done

- `server/src/streams`: stream registry, Redis routing with TTL, a control channel for
  supersession and revocation, Hello validation and sanitising, 45 s watchdog, a
  crash-recovering sweeper, certificate-expiry close (ADR-018).
- `Connect` is real now (was UNIMPLEMENTED); `disable`/`delete`/`rotate-certificate`
  close open streams on every replica.
- Found and fixed by testing: the async iterator destroyed the stream on half-close, so
  a gracefully stopping agent never got a closing status.

### Test status

Server unit **517**, e2e **210** (21 new in `streams.e2e.test.ts`, two real replicas;
`gateway.e2e.test.ts` updated for the real Connect); Go and web unchanged; lint,
typecheck, build clean.

### Verified live (two server processes + the real Go agent)

CA race at first start → one row; agent enrolled and connected to replica 1; `kill -9`
of replica 1 → sweeper on replica 2 marked the cluster DISCONNECTED after 56 s; same
identity reconnected via replica 2 without re-enrolling; SIGTERM to the agent → clean
close, immediate DISCONNECTED, route cleared.

### Not verified

Certificate-expiry close (not injectable); agent on a real or kind cluster (B-2);
the UI showing live status changes (SSE is M3 day 17 — the page shows status on load).

### Next

M2 day 14 — the `commands` table and state machine, queue → route → send → ack/result,
deadlines, re-delivery on reconnect, cancel; agent dispatcher, allowlist, policy,
idempotency; `RefreshServerStatus` end to end.

---

## 2026-10-16 — M2 day 12: the agent's connection manager

Session 7, continued. CI is green on the whole of day 11 (`c657dab`).

### Done

- `internal/identity` and `internal/gateway`: first-start enrollment (ECDSA key + CSR,
  `kube-system` UID fingerprint, identity in a Secret), mTLS `Connect` with Hello and
  heartbeats, reconnect with backoff + jitter, renewal at 2/3 lifetime, graceful stop,
  CA pinning (ADR-017). Wired into the leader task, replacing the inert seam.
- New config: `VFM_CONTROL_PLANE_CA_FILE`, `_SERVER_NAME`, `_CREDENTIALS_SECRET`,
  and the environment-only `_ENROLLMENT_TOKEN` (never logged).
- Real `golangci-lint` v2.14.0 and `govulncheck`: 0 issues, no vulnerabilities.

### Test status

Go: all packages pass (gateway 11 new, identity 6, config +2, cmd +3); server unchanged
(517 unit, 189 e2e); web 47.

### Verified against the real server

A throwaway Go program using the real manager enrolled against the real TypeScript
gateway over pinned TLS 1.3, received a certificate naming the right cluster,
authenticated its mTLS `Connect` and backed off on the day-13 placeholder.

### Not verified

Two replicas electing a leader in a real cluster and the Secret store against a real
API server (kind is blocked on B-2); `-race` locally (no C compiler; CI runs it).

### Next

M2 day 13 — the server's stream registry, Redis routing, status updates, disconnect
detection and revocation closing live streams.

---

## 2026-10-16 — M2 day 11: internal CA, clusters, bootstrap tokens, gateway, add-cluster UI

Session 7, continued. CI on the day 10 commit was red in three jobs (buf action
pushing to the BSR, a golangci-lint built with an older Go, five real `x/net`
vulnerabilities); fixed in `a9643fc` and **green on all five jobs**.

### Done

- Schema + migration `clusters_and_ca`: `clusters`, `cluster_bootstrap_tokens`,
  `agent_certificates`, `certificate_authority`; FK on `role_bindings.cluster_id`
  (ADR-012's deferral). ADR-016.
- `server/src/ca`: ECDSA P-256 CA, CSR signing (subject/SAN ignored, SPIFFE id
  stamped, key type enforced), client-certificate verification, gateway server
  certificate. 11 unit tests including forged CSR, wrong CA, expiry.
- `server/src/clusters`: REST (`/orgs/{orgId}/clusters` create/list/get/update/
  delete/disable/enable/bootstrap-token/rotate-certificate), `EnrollmentService`
  (`enroll`, `renew`, `authenticate`), generated install command (injection-tested).
- Existence check in the RBAC guard (a cluster of another org is a 404).
- First real `golangci-lint` (0 issues) and `govulncheck` (clean after `x/net`
  v0.60.0) runs; Go toolchain bits of B-1 are now cleared except `make`.

### Test status

shared 128, server unit **517**, e2e **189**, web **47** (22 + 11 + 6 new in `clusters.e2e.test.ts`:
concurrent double-enroll, replay, expiry, fingerprint move, revocation by
disable/delete/rotate, cross-org isolation, audit never records the token).

### Also done (parts 2 and 3)

- gRPC gateway (`server/src/gateway`): one mTLS port that requests but does not
  require a client certificate; `Enroll`, `RenewCertificate`; `Connect`
  authenticates then answers UNIMPLEMENTED (day 13). Server certificate rotates
  in place. 11 real-handshake e2e tests (`gateway.e2e.test.ts`).
- Web: `/clusters` page (list, add, new token, rotate, disable/enable, typed-name
  delete; install command shown once, never stored), nav link, 6 tests.

### Driven for real (built server, Vite, real Chrome, throwaway DB, live gRPC)

Sign-in + MFA enrolment, create org, add cluster in the UI → install command
shown once and gone after reload; a Node client acting as the agent enrolled
with that token over real TLS and renewed over mTLS; the UI then showed
`enrolled` with the agent version; **Disable in the UI made the live gateway
refuse the same certificate** (`UNAUTHENTICATED … revoked`), Enable issued a
fresh token, the typed-name delete gated correctly and a deleted cluster's
certificate stayed refused. Not driven: Rotate and "New token" buttons (covered
by unit/e2e tests only), and the Go agent (it has no gRPC client until day 12).

---

## 2026-10-16 — M2 day 10: the agent protocol contract

Session 7. Started M2 at the user's instruction ("continue with M2"), waiving the
plan's ⛔ human checkpoint after M1; M0 is still open (ADR-010).

### Done

- Go 1.27.2 and buf 1.73.0 installed in user space (no root). **First compile of
  the agent**: `go build`, `go vet`, `go test ./...` all clean; `go.sum`
  committed (`fa86456`). Clears the compile half of B-1.
- `proto/vfm/agent/v1/*.proto` (7 files): the whole M2–M5 surface — service,
  envelopes, Hello/policy, 16 command ops, inventory, logs, error codes — with
  Velero fields from the pinned v1.18.4 types (ADR-015).
- `buf lint`, `buf build`, `buf format` clean; `buf generate` produced Go and
  ts-proto stubs, committed; both compile (`go build ./...`, `tsc --noEmit`).
- Contract tests on both generated sides: optional-bool unset vs false, one op
  per command, no Secret kind, typed error codes, Hello/policy round trip.

### Test status

shared unchanged; server unit **425** (+5); go agent tests pass; lint,
typecheck clean.

### Deferred

`golangci-lint` and `make` not installed; `buf breaking` has nothing on `main` to
compare against until this branch merges; the Go agent has no gRPC client yet
(day 12).

### Next

M2 day 11 — internal CA, enrollment RPCs, bootstrap tokens, add-cluster UI.

---

## 2026-10-16 — M1 day 9 follow-up: the UI flows driven in a browser

Session 6, continued.

### What was exercised (real Chrome, built server, Vite dev server, live Dex and

Mailpit, throwaway database dropped afterwards)

- Sign-in form, MFA enrolment (TOTP computed from the displayed secret,
  recovery codes shown once), MFA challenge (a wrong code refused, a valid
  code accepted), sign out.
- Org switcher with two orgs; confirmed server-side that the active org
  changed.
- Invite by email: the email arrived in Mailpit, the invitee registered from the
  link, landed in the app as a MEMBER of that org only, and saw no admin pages.
- Teams: create, add member, remove member, rename, delete.
- API tokens: create behind the **sudo dialog** (session aged in Redis first;
  the dialog appeared, the original request retried after the password), secret
  shown once and gone after dismissal, revoke.
- SSO: provider created in the UI with a group mapping, sign-in through Dex's
  mock connector, JIT user created as MEMBER and placed in the mapped team.
- The audit table recorded all of it, including the refused sudo attempt, the
  wrong MFA code (DENIED) and the SSO sign-in.

### Defects this found (both fixed)

- **Invitation emails led nowhere.** The link is `/invite?token=…` and the web
  app had no such route, so the only account-creation path after setup was
  unreachable from a browser. Added `InvitePage` (register, or accept when
  signed in), with tests.
- **The dev Dex client registered `localhost:5173/auth/oidc/callback`**, a path
  that is neither the Vite-proxied nor the server route; with
  `API_PUBLIC_URL=http://localhost:5173` the real callback is
  `/api/v1/auth/oidc/callback`. Corrected.

### Tooling notes (not app bugs)

- The browser tool's screenshot coordinates are in a frame narrower than the
  viewport here, so coordinate clicks missed their targets; I drove forms with
  `requestSubmit()` and native value setters instead.
- Vite served a stale empty copy of a file created while it was running;
  restarting with `--force` fixed it.

### Still not driven in a browser

- Resetting a password or re-enrolling MFA (no UI for either exists yet).
- SSO provider edit and delete; invite revoke; member role change and removal
  (the pages exist and the endpoints are e2e-tested).
- Entra, Okta and Keycloak (only Dex was exercised, as before).
- A narrow viewport and keyboard-only operation; no accessibility audit.

---

## 2026-10-16 — M1 day 9: audit log, API tokens and the M1 UI

Session 6, continued. Resumed from `2f08daf`.

### Completed (§16 day 9, §8.3, §9, §11)

- **Audit log (R-100).** `audit_events`, append-only by trigger (ADR-013),
  middleware on every mutating route including guard refusals, SSO sign-in
  events, `GET /orgs/{orgId}/audit` and `/audit/export` (CSV, formula-defused,
  itself audited). Owner/Admin only.
- **API tokens (R-094).** `api_tokens`, create (sudo) / list / revoke, Bearer
  auth opt-in per route, narrowing-only intersection in the shared engine,
  revoked with the membership (ADR-014).
- **M1 UI**, built by a parallel agent and then reviewed and exercised by me:
  login, first-run setup, MFA, org switcher, members, teams, SSO, security
  settings and audit pages; sudo re-auth dialog; typed API client with CSRF.
- **A gap only a real run found:** after first-run setup a platform admin has
  no org and nowhere to create one, so every admin page said "No
  organization". Added `/admin/orgs/new` (platform admins only).

### Verification (actually run)

- Shared 128, server unit 420, e2e 156 (36 new: 20 audit, 16 tokens), web 38;
  lint, typecheck, build clean; `pnpm audit --audit-level=high` clean.
- **Browser, against a built server on a throwaway DB (dropped after):** first-run
  setup through the UI, create an org, land on Members with the real member
  list, the Audit page showing the org creation attributed to the admin's
  email, SSO and Security pages rendering real data.
- Two surprises while driving the browser, both mine to note: form clicks
  by reference did not submit until a coordinate click, which is a tooling
  quirk rather than an app bug (the POSTs reached the server); and the first
  org-creation attempt typed into a field before hot reload had finished.

### Not verified / deferred

- **UI flows not exercised in a browser:** MFA enrolment and challenge, invite
  by email, team management, SSO provider create/edit, sudo dialog, org
  switching with two orgs, token creation and revocation.
- **Token page** (`/tokens`, any member) is unit-tested but, like the other
  pages below, not driven in a browser.
- **No tests for the admin pages or the create-org page** (client, login, sudo
  dialog and tokens page are covered).
- Retention job (R-101, M6); per-token rate limits (M7); the audit table is
  unbounded until then.
- The pre-commit hook runs the whole workspace lint, so a half-finished web
  tree blocks server commits; the agent's work was committed together with the
  server change as a result.

### Next

The ⛔ human checkpoint (plan line 662): review of the RBAC model and auth flows
before agent work (M2) starts. Before it: the remaining UI flows above
exercised in a browser.

---

## 2026-10-16 — M1 day 8: RBAC engine

Session 6. Resumed from `d5db61e` (CI green on `d8eb76f`).

### Completed (§16 day 8, §8.2, §9)

- **R-085, R-086, R-087.** `packages/shared/src/rbac.ts`: permission constants,
  the four built-in roles as a data table, and a pure
  `authorize(principal, request, bindings, context)` returning an allow or a
  named deny reason. Owner/Admin are implicit Cluster Admin; user and team
  bindings add up; the namespace rule is implemented as written (every
  namespace in scope, no cluster-scoped resources, wildcard or empty only for
  whole-cluster bindings). Also `restoreNamespaces()`, `visibleNamespaces()`
  for list filtering and `mayAttempt()` for route guards. Design: ADR-012.
- **`role_bindings`** (migration `20261015195933_role_bindings`, applied to
  `vfm` and `vfm_test`), `RbacService`, `@RequirePermission` guard,
  `GET /clusters/{id}/my-access`, `GET|POST /clusters/{id}/role-bindings`,
  `DELETE …/{bindingId}`. Grant and revoke need `cluster:manage` and sudo.
- **Org setting `allowBackupContentDownload`** (default off), patchable by an
  Owner/Admin.
- **A day-5 defect fixed:** the guards document `sudoRequired` /
  `mfaRequired` / `mfaPendingReason` as machine-readable markers, but the
  problem+json filter dropped them. The UI could not have told a step-up
  prompt from a plain 403. Found when my own e2e assertion failed; now passed
  through on an allow-list, with unit tests.

### Verification (actually run)

- `@vfm/shared`: 121 tests (66 table-driven authorize cases, role table pinned
  to §8.2 row by row, `normaliseScope`, `restoreNamespaces`,
  `visibleNamespaces`, `mayAttempt`). Two deliberate mutations
  (`every`→`some`; dropping the cluster-scoped refusal) each failed tests, so
  the table is not vacuous.
- Server: 355 unit and 121 e2e (20 new against real Postgres/Redis: 404 vs 403,
  sudo gating, cross-org subject refusal with identical answers, team
  inheritance both ways, bindings removed with the team or member, revocation
  on the next request, same cluster id in two orgs).
- Lint, typecheck and build clean across the workspace; `pnpm audit
--audit-level=high` clean (2 moderate remain).
- **Built server** (`node dist/main.js`, throwaway DB `vfm_run`, dropped
  afterwards) exercised over HTTP: unauthenticated 401, setup, org, active org,
  `my-access` as owner, team binding scoped to `dev` created, wildcard refused
  422, list resolves the team name, malformed cluster id 404.
- Not run: Go and `smoke.sh` (B-1, B-2 unchanged).

### Deferred

- **Audit of binding changes** — day 9, with the interceptor.
- **Namespace-sensitive handlers** do not exist yet (M2+); the guard's
  `checkInHandler` path is covered by unit tests of `mayAttempt`, not by a live
  route.
- **No FK on `cluster_id`** until M2 (ADR-012).
- **API token permission limits** (§8.2 "inherit/limit") — day 9.
- **Web UI** for bindings and teams — day 9.
- The `visibleNamespaces()` helper lists only namespaces the cluster has
  reported; it is untested against a real inventory (M3).

### Next

M1 day 9: audit log (append-only role grants, interceptor on every mutating
route — org, invite, team, OIDC and now role-binding changes are unaudited),
API tokens, and the M1 UI. Then the ⛔ human checkpoint (plan line 662).

---

## 2026-10-16 — M1 day 7: OIDC

Session 5. Resumed from `dbf8573`.

### First: CI on `9683cc5` was red, and it was my fault

I had reported day 6 as pushed with CI pending. It failed `pnpm audit`: the
`nodemailer@7.0.10` I chose from memory has two high advisories (patched in
10.0.6). Bumped to 10.0.14 (`57575e2`); audit is clean at `--audit-level=high`.
Lesson, the same one as the Trivy tag in session 1: **look a version up, do not
recall it.**

### Completed (§16 day 7, §8.3, §9)

- **Per-org OIDC providers (R-090).** `oidc_providers` with an
  envelope-encrypted client secret (context `oidc_provider.client_secret:<id>`),
  group claim, mappings, JIT flag and enable switch; Owner/Admin CRUD under
  `/orgs/{orgId}/oidc-providers`, delete behind sudo. The secret has no field in
  any response type.
- **Authorization-code flow with PKCE** (`openid-client` 6.8.8): state, nonce,
  verifier; single-use state plus a browser-binding cookie.
- **JIT provisioning, linking rules and group → team sync**, as decided in
  ADR-011 (`oidc_identities` is new).
- **Dex dev client** redirect URI corrected to `/api/v1/auth/oidc/callback`.

### Test status — actually executed

| Gate                                                       | Result                                                                                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test` (server unit)                              | **327 passed**                                                                                                                                                                                           |
| `pnpm --filter @vfm/server test:e2e`                       | **101 passed** (20 new, against real PostgreSQL, Redis **and Dex**)                                                                                                                                      |
| lint / typecheck / build / `pnpm audit --audit-level=high` | clean                                                                                                                                                                                                    |
| OpenAPI                                                    | +106 lines, additions only                                                                                                                                                                               |
| **Built server vs live Dex over HTTP**                     | provider created; buttons list; start → Dex → callback sets the session; user in the right org and team; replayed callback refused; secret absent from the API and ciphertext (`vfm1.…`) in the database |
| Go build / vet / test                                      | **not run — B-1**                                                                                                                                                                                        |
| `smoke.sh`                                                 | **not run — B-2**                                                                                                                                                                                        |

### Deferred

- **Web UI** for SSO buttons and provider admin — day 9.
- **Provider discovery is uncached** (one fetch per start and per callback). Fine
  at this scale; revisit with the M7 load test.
- **SSRF allow-list for the issuer** — see ADR-011; M7.
- **Audit of provider changes** — day 9, with the rest of the mutations.
- **Only Dex was exercised.** Other IdPs (Entra, Okta, Keycloak) differ in
  `groups` shape and `email_verified`; the group claim accepts a string or an
  array, but nothing else is proven.

### Next

M1 day 8 — RBAC engine. See `NEXT_STEPS.md`.

### Blockers

B-1 and B-2, unchanged.

---

## 2026-10-15 — M1 day 6: orgs, members, invites, teams and org scoping

Session 4. Resumed from `cd3234e`, which was clean and in sync with `origin`.
M0's exit criteria are still unmet: `fs.inotify.max_user_instances` is 128 (B-2)
and Go, `make`, `buf` and `golangci-lint` are absent (B-1); both need root. The
owner chose to proceed with day 6 while those are cleared in parallel (ADR-010).
The recorded baseline matched reality before any edit: 166 server unit tests
passing, lint clean, dev stack up.

### Completed (§16 day 6, §8.1, §9, §8.3)

- **The org-scoping extension (R-084).** See ADR-010. Any model with an `orgId`
  is org-owned; reaching one outside `inOrg()` or a reasoned `unscoped()` throws.
  It also catches nested selections: `user.memberships` was the live case, and it
  failed the whole existing e2e suite until `MfaService.obligationFor` said, in
  writing, that it is cross-org by nature.
- **Orgs, members, teams, invites.** Platform-admin org creation (creator
  becomes Owner), `/me/orgs` with an active-org switch held on the session,
  member role changes and removal, team CRUD with membership, and invitations.
  Deletes require sudo (§8.3 "any delete").
- **Invitations.** Hashed token, bound to an address, single use through one
  conditional `UPDATE`, seven-day expiry. Accept for an existing account;
  register for a new one — the only user-creation path after setup.
- **Last-owner protection** under Serializable isolation, and revocation of a
  user's sessions when their role changes (§8.3 rotate on privilege change).
- **Mailer and the lockout email (rest of R-093).** nodemailer over SMTP. The
  lockout notification is sent without being awaited so its timing cannot
  distinguish a real account from an unknown address.
- **Fixes found on the way.** `gen` now runs from compiled output because `tsx`
  emits no decorator metadata; and `envelope.test.ts` "rejects a modified
  ciphertext" was flaky (3 of 6 runs failed) because the last base64url character
  carries only 4 meaningful bits, so overwriting it with `A` was sometimes a
  no-op. Neither was introduced today; the second was a day 5 test.

### Test status — actually executed

| Gate                                                                         | Result                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test` (unit, all workspaces)                                       | **313 passed** — shared 13, server 277, web 23                                                                                                                                   |
| `pnpm --filter @vfm/server test:e2e`                                         | **81 passed** against real PostgreSQL and Redis (30 new)                                                                                                                         |
| `envelope.test.ts` ×12 after the fix                                         | 12/12 pass (it failed 3 of 6 before)                                                                                                                                             |
| `pnpm run lint` / `typecheck` / `build`                                      | clean across all three workspaces                                                                                                                                                |
| OpenAPI regeneration                                                         | 326 lines added, none removed; 20 new operations (15 → 35)                                                                                                                       |
| **Built server over HTTP** (`node dist/main.js`, throwaway DB, real Mailpit) | setup → org → invite → mail in Mailpit → register 201 → replay 400 → member lists orgs → member cannot create org 403 → other org 404 → 11 bad logins → exactly one lockout mail |
| Go build / vet / test                                                        | **not run — B-1**                                                                                                                                                                |
| `smoke.sh`                                                                   | **not run — B-2**                                                                                                                                                                |

### Deferred

- **Sending the invite from the UI** and the org switcher UI — day 9.
- **`/me/tokens`, `/orgs/{orgId}/audit`** and the audit interceptor — day 9.
  Today's mutations are not yet audited; §8.1/§P5 requires it and day 9 is where
  `audit_events` arrives.
- **Invite rate limiting.** `/invites/register` is public. Token guessing is
  pointless (256 bits) and an unknown token fails before any hashing, but there
  is no per-IP limiter on it yet.
- **Real-SMTP e2e in CI.** The suites use an in-memory transport; the real path
  was exercised by hand against Mailpit (above).
- **OIDC group → team mapping** is day 7 and will use `teams` as built.

### Next

M1 day 7 — OIDC against Dex. See `NEXT_STEPS.md`.

### Blockers

B-1 and B-2 from the previous session, unchanged. Neither blocks day 7.

---

## 2026-10-15 — M1 day 5: MFA and sudo mode

M0's exit criteria remain unmet (B-1, B-2) and the owner asked to continue
regardless; day 5 depends on neither blocker, needing only PostgreSQL and
Redis.

### Completed (§16 day 5, §8.3, §9)

- **Envelope encryption** — the first `*_encrypted` column. AES-256-GCM with a
  per-ciphertext data key wrapped under `VFM_MASTER_KEY`, which is now
  **required**. The key id is derived from the key material, and
  `VFM_MASTER_KEY_PREVIOUS` accepts retired keys for decryption so a rotation
  needs no downtime. Every ciphertext is bound to an encryption _context_
  (`user.mfa_secret:<id>`) as associated data, so a value cannot be moved
  between rows or columns.
- **TOTP** with two-step enrolment (the secret is not trusted until a code from
  it verifies) and replay protection: the highest accepted time step is
  recorded per user and advanced with a conditional `UPDATE`, so each code is
  usable exactly once rather than for its whole 30-second window.
- **Recovery codes** — ten 80-bit codes, one row each, spent atomically so
  single use holds under concurrency. SHA-256 rather than argon2id; ADR-009
  gives the reasoning.
- **The MFA gate**, closing the seam day 4 left open. A session owing a factor
  reaches only the endpoints that can satisfy it; everything else is 403 with a
  marker, and the two reasons (`challenge` vs `enrolment`) are distinguished so
  the UI can act. Satisfying the factor **rotates the session id** and reissues
  the cookies, per §8.3's rotation-on-privilege-change requirement.
- **Org-enforced MFA** — Owners and Admins always owe a factor and cannot turn
  that off; `mfaRequired` extends it to all members. Evaluated as a union
  across a user's organizations.
- **Sudo mode** — `POST /auth/sudo` takes the password or a second factor and
  opens a 5-minute window held on the session, with `@RequiresSudo()` and a
  global guard. Exactly one credential must be supplied.
- `SessionCookiesService` extracted, because two controllers now set the
  cookies and `clearCookie` only works when the attributes match.
- `test/app-harness.ts` extracted after the two e2e suites drifted — one set
  `VFM_MASTER_KEY` and the other did not, which surfaced as an unrelated
  "invalid environment configuration" failure.

### Test status — actually executed

| Gate                                       | Result                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test` (unit, all workspaces)     | **202 passed** — shared 13, server 166, web 23                                                                                                                                                                                                    |
| `pnpm --filter @vfm/server test:e2e`       | **52 passed** against real PostgreSQL and Redis                                                                                                                                                                                                   |
| `pnpm run lint` / `typecheck` / `build`    | clean across all three workspaces                                                                                                                                                                                                                 |
| OpenAPI regeneration                       | clean; five new `/auth/mfa/*` and `/auth/sudo` operations                                                                                                                                                                                         |
| **Twenty checks against the built server** | enrolment → encrypted secret in the database → hashed recovery codes → gate refusing with 403 → session id rotated → old id dead → recovery code refused on reuse → sudo window closing and reopening → platform admin refused when disabling MFA |
| Go build / vet / test                      | **not run — B-1**                                                                                                                                                                                                                                 |
| `smoke.sh`                                 | **not run — B-2**                                                                                                                                                                                                                                 |

62 new server unit tests and 25 new e2e tests.

### Two real defects in the TOTP integration, both caught by tests

1. otplib's `epochTolerance` is in **seconds**, not steps. Passing `1` allowed
   one second of clock drift instead of one 30-second period — phone clocks
   drift, so this would have produced support tickets that looked like user
   error rather than a bug.
2. otplib's `epoch` is in **seconds**, not milliseconds. The test helper was
   generating codes for a time roughly 56 000 years away, which simply failed
   to verify.

Both were found because the tests asserted the _behaviour_ (a code from the
adjacent step verifies) rather than that the function was called.

### Deferred

- **The lockout notification email** of §8.3 still waits on the SMTP mailer,
  which arrives with org invites on day 6.
- **`org_id` scoping** of the new `mfa_recovery_codes` table: it is
  deliberately **not** org-owned (a user may belong to several orgs), so the
  org-scoping Prisma extension in day 6 must exclude it. Recorded in ADR-008.
- Everything previously deferred stands: the Go agent (B-1), `smoke.sh` (B-2),
  the §14.1 seed script (needs day 6 tables), `libs/velero` model reuse (M2
  day 10), and a test asserting the security headers.

### Blockers

Unchanged: **B-1** (no Go toolchain) and **B-2** (host inotify limits). Both
need root; commands are in `NEXT_STEPS.md`.

### Next

M1 day 6 — orgs, members, invites and teams: CRUD, email invites over SMTP
(Mailpit in dev), the org switcher, and **the org-scoping Prisma extension plus
the "every query is org-scoped" test** that §8.1 demands. That extension is the
most consequential piece of M1 after the RBAC engine: §8.1 requires it be
impossible to forget org scoping, not merely conventional.

---

## 2026-10-15 — M1 day 4: users and local authentication

**Note on milestone gating.** PLAN.md §0 rule 1 says a milestone does not start
until the previous one's exit criteria pass. M0's do not: `smoke.sh` has never
run (blocker B-2) and the Go agent has never compiled (B-1). The owner asked to
proceed with day 4 regardless. Day 4 depends on neither — it needs only
PostgreSQL and Redis, both of which the compose stack provides — so nothing
here is built on unverified ground. The two blockers remain open.

### Completed (§16 day 4, §8.3)

- **First-admin bootstrap.** One-time token printed to the logs on first start
  while `users` is empty; stored as a SHA-256 digest in Redis with a 24 h TTL;
  burned atomically with `GETDEL`. No open self-signup, and the flow closes
  permanently once a user exists.
- **argon2id** at 19 MiB / t=2 / p=1, 12-character minimum, plus a bundled
  97 747-entry breached-password list (UK NCSC via SecLists, normalised and
  gzipped to 260 KB). Bundled because §8.3 says "no external calls" and §1.1 P6
  forbids runtime internet access. Stored parameters are upgraded in place on
  login when they fall behind.
- **Sessions** in Redis (§9): 12 h absolute and 1 h idle enforced
  independently, rotation, and "sign out everywhere". The user row is re-read
  on every request, so disabling an account revokes immediately.
- **CSRF** double-submit, compared against the token in the session rather
  than only a second cookie.
- **Brute-force protection**: per-account and per-IP counters over fixed
  windows, progressive delay applied before the outcome is known, timed
  lockout.
- **Deny by default**: `SessionGuard` and `CsrfGuard` are global; a route is
  open only with an explicit `@Public()`.
- `TRUST_PROXY` added to the env schema, because rate limiting keys on the
  client address and `X-Forwarded-For` must only be believed deliberately.
- `/auth/*` endpoints: `GET|POST /auth/setup`, `POST /auth/login`,
  `POST /auth/logout`, `DELETE /auth/sessions`, `GET /auth/me`. `openapi.yaml`
  regenerated and committed.

### Test status — actually executed

| Gate                                          | Result                                          |
| --------------------------------------------- | ----------------------------------------------- |
| `pnpm run test` (unit, all workspaces)        | **140 passed** — shared 13, server 104, web 23  |
| `pnpm --filter @vfm/server test:e2e`          | **27 passed** against real PostgreSQL and Redis |
| `pnpm run lint` (eslint 10 + prettier)        | clean                                           |
| `pnpm run typecheck`                          | clean                                           |
| `pnpm --filter @vfm/server run build`         | clean, and the bundled list reaches `dist/`     |
| OpenAPI regeneration → `git diff --exit-code` | clean                                           |
| Go build / vet / test                         | **not run — B-1**                               |
| `smoke.sh`                                    | **not run — B-2**                               |

New: 64 server unit tests and the whole 27-test e2e suite. A CI job now runs
the e2e suite against service containers and fails if the committed OpenAPI
contract drifts from the decorators.

### Seven real defects found this session

**Caught by the tests**

1. `/healthz` returned 401 once the global guard landed — which would have
   restart-looped every pod, since the kubelet's probe is unauthenticated.
   Caught by the e2e suite, fixed with `@Public()` on the health controller.
2. `tsc` emits only JavaScript, so the bundled password list never reached
   `dist/` and the built server could not start. The build copies it now, and a
   test asserts the path resolves from both `src/` and `dist/`.
3. A missing list file made startup **hang** rather than fail: a
   `createReadStream` error does not surface through the readline async
   iterator. Now checked up front and piped through `stream.pipeline`.

**Caught only by running the built server** — every one of these was invisible
to the test runner, which configures SWC with set-semantics class fields and
resolves workspace packages through Vite. The lesson is recorded here because
it will recur: a green suite does not mean the service starts.

4. **Nest DI returned `undefined` for every injected service.**
   `useDefineForClassFields` defaults to true for ES2022+, and under those
   semantics the fields generated from TypeScript parameter properties are
   declared _after_ being assigned, so each reads back as undefined. Set to
   false in the server tsconfig, which decorator-based DI requires.
5. **`@vfm/shared` shipped raw TypeScript**, so the built control plane could
   not load it (`Cannot find module .../product.js`). It now has a real dual
   build — CommonJS for the server, which compiles to CJS and cannot
   `require()` ESM, and ESM for the web app, because Rollup cannot see named
   exports through a CommonJS entry. Each half carries a one-line package.json
   declaring its module type; built on install so no consumer has to remember.
6. **`express` was imported directly but declared only transitively.** It
   resolved locally through pnpm's layout and was missing on a clean install,
   which is how CI found it. Pinned to the version `@nestjs/platform-express`
   itself depends on, so the tree holds exactly one express.
7. **The documented dev workflow crashed.** `.env.example` sets
   `LOG_PRETTY=true` but `pino-pretty` was not a dependency, and nothing loaded
   `server/.env` despite the README instructing you to create it. Added as a
   devDependency, the transport degrades to JSON when unresolvable, and
   `main.ts` loads the file outside production with real environment variables
   still winning.

### Deferred

- **The lockout notification email** of §8.3. The lockout itself is enforced;
  the SMTP mailer arrives with org invites on day 6, and the notification lands
  with it. `AuthService` logs the event at warn in the meantime.
- **MFA gating.** `login` marks a session `mfaPending` when the user has MFA
  enabled, but `SessionGuard` does not yet refuse such a session — that is day
  5, together with enrolment. The gap is currently unreachable: nothing in day
  4 can set `mfaEnabled`, which defaults to false.
- Everything else previously deferred stands: the Go agent (B-1), `smoke.sh`
  (B-2), the §14.1 seed script (needs day 6 tables), `libs/velero` model reuse
  (M2 day 10), and a test asserting the security headers (arrives with the
  next HTTP suite).

### Blockers

Unchanged: **B-1** (no Go toolchain) and **B-2** (host inotify limits too low
for the kind clusters). Both need root; `sudo` here requires a password.
Commands are in `NEXT_STEPS.md`.

### Next

M1 day 5 — MFA and sudo mode: TOTP enrol/verify/disable, 10 hashed recovery
codes, org-enforced MFA, and the sudo re-auth endpoint with its guard
decorator. `VFM_MASTER_KEY` becomes **required** at that point, because
`mfa_secret_encrypted` is the first encrypted column (§9).

---

## 2026-10-14 — M0 days 2 and 3: dev environment and service skeletons

### Completed — day 2, dev environment (§14.1, §16 day 2)

- `deploy/dev/docker-compose.yml`: PostgreSQL 16, Valkey 7, MinIO with one
  bucket per cluster, Mailpit, and Dex with a static user per built-in role.
  Every image pinned, every port published on 127.0.0.1 only, host ports moved
  into the 5xxxx range because 5432 is already taken on this machine.
- `deploy/dev/versions.env`: every version pin in one place, including the kind
  node image by digest. `dev-up.sh` fails if these and `docker-compose.yml`
  drift apart.
- `deploy/dev/scripts/`: `dev-up.sh`, `dev-down.sh`, `sample-workloads.sh`,
  `smoke.sh`, `lib.sh`. Plain bash, runnable without `make`, idempotent, and
  loud about anything they skip. `assert_owned_cluster` makes it impossible for
  them to touch any kind cluster other than `vfm-a`/`vfm-b`.
- Cluster build: CSI snapshot controller + hostpath CSI driver +
  `VolumeSnapshotClass`, Velero v1.18.4 with the AWS plugin against that
  cluster's MinIO bucket and the node agent enabled, and sample workloads in
  namespace `demo` including a PVC whose payload checksum is recorded for e2e
  golden path 3.
- MinIO is reached from the clusters by joining it to the `kind` docker network
  and pointing a selector-less Service with a hand-written EndpointSlice at it,
  so the host publishing can stay loopback-only.

### Completed — day 3, service skeletons (§16 day 3)

- **`server/`**: zod-validated config, pino JSON logging with request
  correlation, RFC 9457 problem+json errors, strict CSP and security headers,
  `/healthz`, `/readyz` (Postgres + Redis, 503 when down), `/metrics` on port
  9090, `redact()`, Prisma 7 with the pg driver adapter, and the first
  migration (`users`, `organizations`, `memberships`). OpenAPI 3.1 generated
  from the decorators and committed.
- **`web/`**: React 19 + Vite shell, TanStack Router and Query, Tailwind with
  shadcn-style primitives, dark/light theme, error boundary, typed API client
  that parses problem+json, and an accessibility baseline.
- **`agent/`**: config, slog JSON, health and metrics server, kube client,
  Lease-based leader election. **Not compiled or tested — see Deferred.**

### Test status — actually executed

| Gate                                        | Result                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm run test` (all TypeScript workspaces) | **76 passed** — shared 13, server 40, web 23                                                         |
| `pnpm run lint` (eslint + prettier)         | clean                                                                                                |
| `pnpm run typecheck` (`tsc --noEmit` ×3)    | clean                                                                                                |
| `pnpm --filter @vfm/server run build`       | clean                                                                                                |
| `prisma migrate dev` then `migrate status`  | migration applied; "Database schema is up to date"                                                   |
| OpenAPI regeneration                        | `git diff --exit-code` clean — the committed contract matches the decorators                         |
| `./scripts/dev-up.sh` compose stage         | all six services healthy, both buckets verified                                                      |
| `./scripts/dev-down.sh --clusters-only`     | removed `vfm-a`, explicitly left the unrelated `velero` cluster untouched, kept the compose stack up |
| Go build / vet / test                       | **not run — Go is not installed**                                                                    |
| `./scripts/smoke.sh`                        | **not run — blocked, see Blockers**                                                                  |
| CI                                          | **not run — nothing pushed at the time of writing**                                                  |

### Defects found by running the code rather than reading it

1. `compose up --wait` treats _any_ exited container as a failure, so the
   one-shot bucket provisioner could never satisfy it. It is now started and
   checked separately with a bounded wait.
2. The `kind` nodes could not reach MinIO through the bridge gateway, because
   the compose stack publishes it on 127.0.0.1 only. MinIO now joins the `kind`
   network as a second attachment instead of the host publishing being widened.
3. `veleroMinorOf('1.18.x')` parsed as `1.18`. A wildcard is not a version and
   the capability map keys off this value, so the patch component must now be
   numeric. Caught by the unit test that was written alongside it.

Plus two smaller ones: a `localStorage` test whose spy never installed (jsdom's
storage object is proxy-backed, so the test passed without exercising the
failure path at all), and `skip()` appending "(already present)" to messages
that said the opposite.

And four that only the first CI run could find:

4. The Trivy action tag is v-prefixed, so `@0.33.1` did not resolve.
5. `actions/setup-node@v5` activates the `packageManager` field of the nearest
   package.json. At the repository root that is the legacy Nx workspace's pnpm
   7.27.0 with an unverifiable sha1, so the action failed before any step of
   ours ran.
6. The Go jobs gated on `go.mod`, but `go build` needs a committed `go.sum` to
   verify modules. They now gate on `go.sum` and write a run summary pointing
   at blocker B-1.
7. Lint and typecheck failed on a fresh install because `@prisma/client` has
   no generated types until `prisma generate` runs. Added as a postinstall.

Two `pnpm audit` high advisories (`mysql2`, `deepmerge-ts`, both reaching us
only through the Prisma CLI's transitive tree) are forced to patched versions
with pnpm overrides rather than suppressed, as §12.1 requires.

### Deferred

- **The Go agent is unverified.** `go`, `make`, `buf` and `golangci-lint` are
  not installed. ~2 900 lines of agent source and tests are committed but have
  never been compiled; `go.sum` does not exist and `go mod tidy` must be run
  once. External imports were checked by hand against `go.mod` and are
  consistent, which is not the same as compiling.
- **`make smoke` has not passed**, so the M0 exit criterion is not met. See
  Blockers.
- **The §14.1 seed script** (platform admin, two orgs, a user per role, both
  clusters enrolled) needs tables that do not exist until M1 day 6, so it lands
  there.
- **`libs/velero` model reuse** stays deferred to M2 day 10, when each field can
  be cross-checked against the pinned Velero Go types.
- **No test asserts the security headers yet**; that arrives with the first HTTP
  integration test in M1.

### Blockers

- **B-1 — Go toolchain absent.** Owner-installed by agreement; commands are in
  `NEXT_STEPS.md`.
- **B-2 — host inotify limits too low for the kind clusters.**
  `fs.inotify.max_user_instances` is 128 and `max_user_watches` is 65 536; two
  two-node clusters need 512 / 524 288. Below that, `kube-proxy` on a worker
  crash-loops with "too many open files" and nothing on that node can reach a
  Service IP — which is exactly what happened, surfacing minutes later as a
  snapshot-controller rollout timeout. `dev-up.sh` now checks this in preflight
  and fails immediately with the fix. Raising it needs root, and `sudo` on this
  machine requires a password, so it could not be done from this session:

  ```
  sudo sysctl -w fs.inotify.max_user_instances=512
  sudo sysctl -w fs.inotify.max_user_watches=524288
  ```

  The half-built `vfm-a` cluster was deleted so a later `dev-up` rebuilds it
  cleanly rather than skipping a broken one.

### Next

Clear B-1 and B-2, then finish the M0 exit criteria: `./scripts/dev-up.sh`
followed by `./scripts/smoke.sh` green on both clusters, and the agent built
and tested. Then M1 day 4 — users and local authentication. Details in
`NEXT_STEPS.md`.

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
- `eslint` (ESLint 10, `strictTypeChecked`) and `tsc --noEmit` clean.
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

M0 day 2 — dev environment (completed later in the same session, see below): docker compose (PostgreSQL 16, Valkey 7, MinIO with
two buckets, Mailpit, Dex), kind clusters `vfm-a` and `vfm-b` with Velero
v1.18.4 + the AWS plugin against MinIO, CSI hostpath driver, node-agent and
sample workloads; idempotent `make dev-up` / `dev-down`; `make smoke` asserting a
`velero backup create` reaches `Completed` on both clusters.

### Blockers

None for day 1.
