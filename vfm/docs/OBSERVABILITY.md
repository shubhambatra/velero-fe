# Observability (M7 day 40)

What the control plane reports about itself: metrics, logs, and an optional trace hook. VFM is not an observability platform
(PLAN.md §1 non-goals); these exist so an operator can tell whether VFM itself is healthy.

## Metrics

Prometheus text format on a **separate listener**, `METRICS_PORT` (default 9090), path `/metrics`. Nothing else is served
there and it must not be exposed publicly (a test checks the first half). Every metric is prefixed `vfm_`; the runtime's own
(`vfm_nodejs_*`, `vfm_process_*`) come with it. Metrics are **per replica**: sum across replicas in PromQL.

| Metric                              | Type      | Labels                                           | Meaning                                                                                                                                   |
| ----------------------------------- | --------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `vfm_agents_connected`              | gauge     |                                                  | Agent streams open on this replica.                                                                                                       |
| `vfm_agent_stream_connects_total`   | counter   | `kind` = `first` \| `reconnect`                  | Streams opened; `reconnect` when this replica has had that cluster before.                                                                |
| `vfm_agent_stream_ends_total`       | counter   | `reason` = `dropped` \| `superseded` \| `closed` | How streams ended.                                                                                                                        |
| `vfm_sse_subscribers`               | gauge     |                                                  | Browser event streams open on this replica.                                                                                               |
| `vfm_sse_connects_total`            | counter   |                                                  | Browser streams opened. A rate far above the user count means browsers reconnecting.                                                      |
| `vfm_commands_total`                | counter   | `op`, `status`                                   | Command transitions, by the status entered.                                                                                               |
| `vfm_command_duration_seconds`      | histogram | `op`, `status`                                   | Request to final status (SUCCEEDED, FAILED, TIMED_OUT, CANCELLED, REJECTED).                                                              |
| `vfm_commands_unfinished`           | gauge     | `status`                                         | **Work queue depth** across every org: QUEUED, SENT, ACKED, RUNNING, PENDING_APPROVAL. Read from the database at most every 5 s.          |
| `vfm_http_request_duration_seconds` | histogram | `method`, `route`, `status_class`                | REST latency. `route` is the template (`/api/v1/orgs/:orgId/clusters`), unmatched requests are `unmatched`; the event stream is excluded. |
| `vfm_alert_deliveries_total`        | counter   | `kind`, `ok`                                     | Alert notifications attempted.                                                                                                            |
| `vfm_rate_limited_total`            | counter   | `name`                                           | Requests refused by a rate limit.                                                                                                         |

**Labels are bounded by construction.** No label is an id, a name or a raw path; `observability.test.ts` fails if one is
added that is not on the allow-list. Time-series count is therefore fixed by the API's size, not by the number of clusters
or users.

PLAN §13's list maps as: connected agents → `vfm_agents_connected`; command counts and latency by type and status →
`vfm_commands_total`, `vfm_command_duration_seconds`; stream reconnects → `vfm_agent_stream_connects_total{kind="reconnect"}`;
SSE subscribers → `vfm_sse_subscribers`; HTTP latency → `vfm_http_request_duration_seconds`; job queue depth →
`vfm_commands_unfinished` (commands are the only queued work; alert evaluation and the timeout sweeper are timers).

### Dashboard and alerts

- `deploy/observability/vfm-control-plane.dashboard.json`: Grafana dashboard, 16 panels (agents, browsers, queue, 5xx, latency
  overall and by route, commands, reconnects, rate limits, alert deliveries, event-loop lag, memory and CPU). Import it and pick
  a Prometheus data source.
- `deploy/observability/vfm-alerts.rules.yaml`: seven Prometheus rules (metrics missing, p95 over 300 ms, 5xx ratio, command
  backlog, agents flapping, event-loop lag, alert deliveries failing).

A test (`src/metrics/observability.test.ts`) fails if either file queries a metric the control plane does not expose.
**Not verified:** the JSON has not been imported into a real Grafana and the rules have not been run through `promtool`
(neither is installed here); do that once when the chart ships (day 41).

## Logs

JSON, one object per line, on stdout (`LOG_PRETTY=true` is a development convenience only). Level from `LOG_LEVEL`.

Every line has `level` (pino numbers: 30 info, 40 warn, 50 error), `time` (ms since epoch), `pid`, `hostname`, `msg`.
A request line (`msg: "request completed"`) adds exactly:

| Field                                | Meaning                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `req.id`                             | The request id, also returned as `X-Request-Id` and shown in every error body. An inbound id is reused only if it looks like one. |
| `req.method`, `req.url`              | The method and the path. **The query string is dropped**: it can carry one-time codes (the SSO callback's `code` and `state`).    |
| `req.remoteAddress`, `req.userAgent` | Peer address (behind a proxy, the proxy) and the first 200 characters of the user agent.                                          |
| `res.statusCode`, `responseTime`     | Outcome and milliseconds.                                                                                                         |
| `requestIdHeader`                    | The header name, for log shippers.                                                                                                |

No other header is written. Cookies, `Authorization`, CSRF tokens and `Set-Cookie` are redacted even if added later
(`PINO_REDACT_PATHS`). Errors are logged through the single `redact()` function. `/healthz`, `/readyz` and `/metrics` are not logged.
A lost database or cache logs one warning (`a dependency is unavailable`) and answers 503. `logfields.e2e` pins the line.

Audit events (who did what to which object) are a separate, durable record in the database, not logs.

## Tracing (off by default)

`withSpan(name, attributes, fn)` wraps the work worth timing; today that is delivering a command to an agent
(`command.deliver`, attributes `vfm.cluster_id`, `vfm.command_id`, `vfm.op`). Without an SDK it is a no-op that costs nothing.
Attributes are ids and enums only, never payloads or names.

To turn tracing on, install `@opentelemetry/sdk-node` next to the server (it is not shipped, so the default image has no extra
dependencies), set `OTEL_ENABLED=true` and the standard variables, e.g. `OTEL_EXPORTER_OTLP_ENDPOINT`. If the SDK cannot be loaded
the server logs one warning and starts without tracing: a tracing problem never stops the control plane. **Not verified end to
end:** no collector was run here; the tests cover the on/off/missing-SDK behaviour with a fake SDK.
