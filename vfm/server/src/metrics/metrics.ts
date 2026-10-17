import { Counter, Gauge, Histogram } from '@prometheus-io/client';

import { PRODUCT_SLUG } from '@vfm/shared';

import { metricsRegistry } from './metrics.server';

/**
 * The metrics of PLAN.md §13 (docs/OBSERVABILITY.md has the catalogue). Defined once here and
 * imported by the modules that own what they measure, so the names and labels are reviewed in one place.
 *
 * **Labels are bounded.** None is an id, a name or a path with parameters in it: `op` and `status` are
 * enums, `route` is the route template. A label that grew with the data would grow the time-series store.
 */
const p = `${PRODUCT_SLUG}_`;
const register = [metricsRegistry];

export const httpDuration = new Histogram({
  name: `${p}http_request_duration_seconds`,
  help: 'REST request latency, from arrival to the last byte, by method, route template and status class.',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10],
  registers: register,
});

export const agentsConnected = new Gauge({
  name: `${p}agents_connected`,
  help: 'Agent streams held open by this replica.',
  registers: register,
});

export const agentStreamConnects = new Counter({
  name: `${p}agent_stream_connects_total`,
  help: 'Agent streams opened on this replica; kind="reconnect" when this replica has seen the cluster before.',
  labelNames: ['kind'],
  registers: register,
});

export const agentStreamEnds = new Counter({
  name: `${p}agent_stream_ends_total`,
  help: 'Agent streams that ended on this replica, by how: superseded by a newer connection, closed by the server, or dropped.',
  labelNames: ['reason'],
  registers: register,
});

export const sseSubscribers = new Gauge({
  name: `${p}sse_subscribers`,
  help: 'Browser event streams (GET /stream) held open by this replica.',
  registers: register,
});

export const sseConnects = new Counter({
  name: `${p}sse_connects_total`,
  help: 'Browser event streams opened on this replica (a rate far above the number of users means browsers are reconnecting).',
  registers: register,
});

export const commandsTotal = new Counter({
  name: `${p}commands_total`,
  help: 'Command state transitions, by operation and the status entered.',
  labelNames: ['op', 'status'],
  registers: register,
});

export const commandDuration = new Histogram({
  name: `${p}command_duration_seconds`,
  help: 'Time from a command being requested to it reaching a final status, by operation and status.',
  labelNames: ['op', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900, 3600],
  registers: register,
});

let sampleUnfinished: () => Promise<void> = () => Promise.resolve();

/** The command service says how to read the queue; the gauge asks for it at each scrape. */
export function onSampleUnfinished(sample: () => Promise<void>): void {
  sampleUnfinished = sample;
}

export const commandsUnfinished = new Gauge({
  name: `${p}commands_unfinished`,
  help: 'Commands not yet finished (the work queue), by status, across every organization. Read from the database at most every 5 s.',
  labelNames: ['status'],
  registers: register,
  async collect() {
    await sampleUnfinished();
  },
});

export const alertDeliveries = new Counter({
  name: `${p}alert_deliveries_total`,
  help: 'Alert notifications attempted, by kind and whether the channel accepted them.',
  labelNames: ['kind', 'ok'],
  registers: register,
});

export const rateLimited = new Counter({
  name: `${p}rate_limited_total`,
  help: 'Requests refused by a rate limit, by limit name.',
  labelNames: ['name'],
  registers: register,
});
