import 'reflect-metadata';

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommandAckState } from '../src/gateway/pb/vfm/agent/v1/command';
import { metricsRegistry, startMetricsServer } from '../src/metrics/metrics.server';
import { createTestApp, type TestApp } from './app-harness';
import { World } from './world';

/**
 * M7 day 40: the metrics of PLAN.md §13 move when the thing they measure happens, and their labels stay
 * bounded. Real PostgreSQL, Redis and gRPC; the registry is read the way Prometheus reads it.
 */
const scrape = async (): Promise<string> => metricsRegistry.metrics();

/** The value of one series, or undefined if it has not been created. */
function value(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const ok = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
    if (ok) return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return undefined;
}

describe('metrics (e2e)', () => {
  let harness: TestApp;
  let world: World;
  let httpPort = 0;

  beforeAll(async () => {
    harness = await createTestApp({ gateway: true });
    await harness.app.listen(0, '127.0.0.1');
    httpPort = ((harness.app.getHttpServer() as http.Server).address() as AddressInfo).port;
    world = new World(harness);
    await world.init();
  }, 60_000);

  afterAll(async () => {
    world.close();
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it('counts agent streams: connected now, first versus reconnect, and how each ended', async () => {
    const { call, orgId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const before = await scrape();
    const first0 = value(before, 'vfm_agent_stream_connects_total', { kind: 'first' }) ?? 0;
    const re0 = value(before, 'vfm_agent_stream_connects_total', { kind: 'reconnect' }) ?? 0;
    const connected0 = value(before, 'vfm_agents_connected') ?? 0;

    const one = await world.connect(agent);
    const afterOne = await scrape();
    expect(value(afterOne, 'vfm_agents_connected')).toBe(connected0 + 1);
    expect(value(afterOne, 'vfm_agent_stream_connects_total', { kind: 'first' })).toBe(first0 + 1);

    one.cancel();
    await one.ended;
    const two = await world.connect(agent);
    const afterTwo = await scrape();
    expect(value(afterTwo, 'vfm_agent_stream_connects_total', { kind: 'reconnect' })).toBe(re0 + 1);
    expect(value(afterTwo, 'vfm_agents_connected')).toBe(connected0 + 1);
    expect(
      value(afterTwo, 'vfm_agent_stream_ends_total', { reason: 'dropped' }),
    ).toBeGreaterThanOrEqual(1);
    two.cancel();
  });

  it('counts and times a command, and shows the work queue', async () => {
    const { call, orgId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await world.connect(agent);
    const issued = await call(
      'post',
      `/orgs/${orgId}/clusters/${agent.clusterId}/refresh-status`,
    ).expect(202);
    const id = (issued.body as { id: string }).id;
    expect((await stream.next()).command?.commandId).toBe(id);
    const t0 = await scrape();
    const done0 =
      value(t0, 'vfm_commands_total', { op: 'REFRESH_STATUS', status: 'SUCCEEDED' }) ?? 0;
    const hist0 =
      value(t0, 'vfm_command_duration_seconds_count', {
        op: 'REFRESH_STATUS',
        status: 'SUCCEEDED',
      }) ?? 0;

    stream.send({
      messageId: 'a',
      ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
    });
    stream.send({ messageId: 'r', result: { commandId: id, ok: true } });
    const deadline = Date.now() + 5_000;
    let text = await scrape();
    while (
      (value(text, 'vfm_commands_total', { op: 'REFRESH_STATUS', status: 'SUCCEEDED' }) ?? 0) ===
      done0
    ) {
      if (Date.now() > deadline) throw new Error('the command was never counted');
      await new Promise((r) => setTimeout(r, 50));
      text = await scrape();
    }
    expect(
      value(text, 'vfm_command_duration_seconds_count', {
        op: 'REFRESH_STATUS',
        status: 'SUCCEEDED',
      }),
    ).toBe(hist0 + 1);
    // The queue gauge exists for every status, so a dashboard never has a gap.
    for (const status of ['QUEUED', 'SENT', 'ACKED', 'RUNNING', 'PENDING_APPROVAL']) {
      expect(value(text, 'vfm_commands_unfinished', { status }), status).toBeDefined();
    }
    stream.cancel();
  });

  it('times REST requests by route template, never by URL', async () => {
    const { call, orgId } = await world.admin();
    await call('get', `/orgs/${orgId}/clusters`).expect(200);
    await harness
      .api()
      .get('/api/v1/definitely/not/a/route/0194f9d2-0000-7000-8000-00000000c001')
      .expect(404);
    const text = await scrape();
    const routes = [
      ...text.matchAll(/vfm_http_request_duration_seconds_count\{[^}]*route="([^"]*)"/g),
    ].map((m) => m[1] ?? '');
    expect(routes).toContain('/api/v1/orgs/:orgId/clusters');
    expect(routes).toContain('unmatched');
    expect(
      routes.filter((r) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(r)),
      'a route label holds an id',
    ).toEqual([]);
    expect(routes.some((r) => r.endsWith('/stream'))).toBe(false);
  });

  it('counts browser event streams while they are open', async () => {
    const { call } = await world.admin();
    const base = value(await scrape(), 'vfm_sse_subscribers') ?? 0;
    const req = http.get(
      {
        host: '127.0.0.1',
        port: httpPort,
        path: '/api/v1/stream',
        headers: { Cookie: (call as unknown as { cookie: string }).cookie },
      },
      (res) => {
        res.resume();
      },
    );
    const deadline = Date.now() + 5_000;
    while ((value(await scrape(), 'vfm_sse_subscribers') ?? 0) !== base + 1) {
      if (Date.now() > deadline) throw new Error('the subscriber was never counted');
      await new Promise((r) => setTimeout(r, 50));
    }
    req.destroy();
    while ((value(await scrape(), 'vfm_sse_subscribers') ?? 0) !== base) {
      if (Date.now() > deadline + 5_000) throw new Error('the subscriber was never released');
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('serves the registry on its own listener, and nothing else there', async () => {
    const server = startMetricsServer('127.0.0.1', 0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, body });
            });
          })
          .on('error', reject);
      });
    const ok = await get('/metrics');
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('vfm_agents_connected');
    expect((await get('/api/v1/clusters')).status).toBe(404);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
});
