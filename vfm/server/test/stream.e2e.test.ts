import 'reflect-metadata';

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAX_STREAMS_PER_USER, streamOptions } from '../src/events/stream.controller';
import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Call } from './world';

/**
 * `GET /api/v1/stream` over a real HTTP connection, with two control-plane
 * replicas. Events are thin and filtered per receiving user; these tests hold the
 * line on both: who gets what, how soon a revoked grant stops, and that a stream
 * cannot outlive its session or multiply without bound.
 */
interface Sse {
  status: number;
  events: { event: string; data: Record<string, unknown> }[];
  raw: () => string;
  closed: Promise<void>;
  close: () => void;
  waitFor: (
    predicate: (e: { event: string; data: Record<string, unknown> }) => boolean,
    ms?: number,
  ) => Promise<void>;
}

function openSse(port: number, headers: Record<string, string>): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/stream', headers }, (res) => {
      let buffer = '';
      let raw = '';
      const events: Sse['events'] = [];
      const waiters: (() => void)[] = [];
      let finish: () => void = () => undefined;
      const closed = new Promise<void>((r) => {
        finish = r;
      });
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        buffer += chunk;
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event !== undefined && data !== undefined) {
            events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
            for (const w of waiters.splice(0)) {
              w();
            }
          }
        }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
      const sse: Sse = {
        status: res.statusCode ?? 0,
        events,
        raw: () => raw,
        closed,
        close: () => {
          req.destroy();
        },
        waitFor: async (predicate, ms = 5_000) => {
          const deadline = Date.now() + ms;
          while (!events.some(predicate)) {
            const left = deadline - Date.now();
            if (left <= 0) {
              throw new Error(`timed out waiting for an event; got ${JSON.stringify(events)}`);
            }
            await new Promise<void>((r) => {
              const t = setTimeout(r, left);
              waiters.push(() => {
                clearTimeout(t);
                r();
              });
            });
          }
        },
      };
      resolve(sse);
    });
    req.on('error', reject);
  });
}

const quiet = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('server-sent events (e2e, two replicas)', () => {
  let a: TestApp;
  let b: TestApp;
  let worldA: World;
  let portHttpA: number;
  const opened: Sse[] = [];

  beforeAll(async () => {
    a = await createTestApp({ gateway: true });
    b = await createTestApp({ gateway: true });
    worldA = new World(a);
    await worldA.init();
    await a.app.listen(0, '127.0.0.1');
    // Replica B is only ever the source of events; it needs no HTTP port here.
    portHttpA = ((a.app.getHttpServer() as http.Server).address() as AddressInfo).port;
  }, 90_000);

  afterAll(async () => {
    for (const s of opened) {
      s.close();
    }
    worldA.close();
    await b.close();
    await a.close();
  });

  beforeEach(async () => {
    await a.reset();
    streamOptions.permissionTtlMs = 10_000;
    // Most cases below read events one by one; coalescing has its own.
    streamOptions.coalesceMs = 0;
    streamOptions.sessionCheckMs = 60_000;
  });

  const sse = async (port: number, call: Call): Promise<Sse> => {
    const s = await openSse(port, { Cookie: (call as unknown as { cookie: string }).cookie });
    opened.push(s);
    return s;
  };

  it('streams cluster status, inventory and command events to a user who may see the cluster', async () => {
    const { call, orgId } = await worldA.admin();
    const agent = await worldA.agent(call, orgId, 'prod-eu');
    const watcher = await sse(portHttpA, call);
    expect(watcher.status).toBe(200);

    const stream = await worldA.connect(agent);
    await watcher.waitFor((e) => e.event === 'cluster' && e.data.status === 'CONNECTED');

    stream.send({
      messageId: 's',
      snapshot: { snapshotId: 's1', sequence: 0, last: true, items: [resource('b1')] },
    });
    await watcher.waitFor(
      (e) => e.event === 'inventory' && (e.data.kinds as string[]).includes('BACKUP'),
    );

    await call('post', `/orgs/${orgId}/clusters/${agent.clusterId}/refresh-status`).expect(202);
    await watcher.waitFor((e) => e.event === 'command');

    stream.cancel();
    await stream.ended;
    await watcher.waitFor((e) => e.event === 'cluster' && e.data.status === 'DISCONNECTED');
  });

  it('never puts an object’s name or contents in an event', async () => {
    const { call, orgId } = await worldA.admin();
    const agent = await worldA.agent(call, orgId, 'prod-eu');
    const watcher = await sse(portHttpA, call);
    const stream = await worldA.connect(agent);
    stream.send({
      messageId: 's',
      snapshot: {
        snapshotId: 's1',
        sequence: 0,
        last: true,
        items: [resource('super-secret-backup-name')],
      },
    });
    await watcher.waitFor((e) => e.event === 'inventory');
    expect(watcher.raw()).not.toContain('super-secret-backup-name');
    stream.cancel();
  });

  it('delivers an event handled by the other replica', async () => {
    const { call, orgId } = await worldA.admin();
    const agent = await worldA.agent(call, orgId, 'prod-eu');
    const watcher = await sse(portHttpA, call);

    // The agent's stream lives on replica B; the browser's lives on A.
    const worldB = new World(b);
    await worldB.init();
    worldB.caPem = worldA.caPem;
    const stream = await worldB.connect(agent);
    await watcher.waitFor((e) => e.event === 'cluster' && e.data.status === 'CONNECTED');
    stream.cancel();
    worldB.close();
  });

  it('shows a user nothing about a cluster they cannot see, and starts once they can', async () => {
    streamOptions.permissionTtlMs = 50;
    const { call, orgId } = await worldA.admin();
    const agent = await worldA.agent(call, orgId, 'prod-eu');
    const dev = await worldA.member(call, orgId, 'dev@acme.test');
    const owner = await sse(portHttpA, call);
    const watcher = await sse(portHttpA, dev.call);

    const stream = await worldA.connect(agent);
    await owner.waitFor((e) => e.event === 'cluster');
    await quiet();
    expect(watcher.events).toEqual([]);

    await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
      subjectType: 'USER',
      subjectId: dev.userId,
      role: 'VIEWER',
      scope: { type: 'CLUSTER' },
    }).expect(201);
    await quiet(150);
    stream.send({
      messageId: 's',
      snapshot: { snapshotId: 's1', sequence: 0, last: true, items: [resource('b1')] },
    });
    await watcher.waitFor((e) => e.event === 'inventory');
    stream.cancel();
  });

  it('stops delivering within the permission window once a grant is revoked', async () => {
    streamOptions.permissionTtlMs = 50;
    const { call, orgId } = await worldA.admin();
    const agent = await worldA.agent(call, orgId, 'prod-eu');
    const dev = await worldA.member(call, orgId, 'dev@acme.test');
    const binding = await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
      subjectType: 'USER',
      subjectId: dev.userId,
      role: 'VIEWER',
      scope: { type: 'CLUSTER' },
    }).expect(201);
    const watcher = await sse(portHttpA, dev.call);
    const stream = await worldA.connect(agent);
    await watcher.waitFor((e) => e.event === 'cluster');

    await call(
      'delete',
      `/clusters/${agent.clusterId}/role-bindings/${(binding.body as { id: string }).id}`,
    ).expect(204);
    await quiet(200);
    const seen = watcher.events.length;
    stream.send({
      messageId: 's',
      snapshot: { snapshotId: 's1', sequence: 0, last: true, items: [resource('b1')] },
    });
    await quiet(500);
    expect(watcher.events.length).toBe(seen);
    stream.cancel();
  });

  // With the built-in roles every read permission arrives together, so no browser session can
  // yet differ per kind; the per-kind filter is exercised through the API-token limits in the
  // inventory suite. This pins what an event reports.
  it('reports which kinds changed in one snapshot', async () => {
    streamOptions.permissionTtlMs = 50;
    const { call, orgId } = await worldA.admin();
    const agent = await worldA.agent(call, orgId, 'prod-eu');
    const stream = await worldA.connect(agent);
    const owner = await sse(portHttpA, call);

    stream.send({
      messageId: 's',
      snapshot: {
        snapshotId: 's1',
        sequence: 0,
        last: true,
        items: [
          resource('b1'),
          resource('nightly', { kind: ResourceKind.RESOURCE_KIND_SCHEDULE, phase: 'Enabled' }),
        ],
      },
    });
    await owner.waitFor((e) => e.event === 'inventory');
    const kinds = owner.events.find((e) => e.event === 'inventory')?.data.kinds as string[];
    expect(kinds.sort()).toEqual(['BACKUP', 'SCHEDULE']);
    stream.cancel();
  });

  it('does not deliver another organization’s events', async () => {
    const one = await worldA.admin();
    const agent = await worldA.agent(one.call, one.orgId, 'prod-eu');

    // A second org with its own owner, watching.
    const second = await one.call('post', '/orgs', { name: 'Other', slug: 'other' }).expect(201);
    const otherOrg = (second.body as { id: string }).id;
    await one.call('post', '/me/active-org', { orgId: otherOrg }).expect(204);
    const watcher = await sse(portHttpA, one.call);

    const stream = await worldA.connect(agent);
    await quiet(500);
    expect(watcher.events).toEqual([]);
    stream.cancel();
  });

  it('needs a session and an active organization', async () => {
    const none = await openSse(portHttpA, {});
    expect(none.status).toBe(401);
    none.close();

    await worldA.admin();
    // Signed in but no active organization selected.
    const setupUser = await a.prisma.unscoped('t', () => a.prisma.user.findFirstOrThrow());
    const bare = await worldA.actAs(setupUser.id);
    const s = await openSse(portHttpA, { Cookie: (bare as unknown as { cookie: string }).cookie });
    expect(s.status).toBe(400);
    s.close();
  });

  it('refuses an API token: browser streams only', async () => {
    const { call, orgId } = await worldA.admin();
    const token = await call('post', `/orgs/${orgId}/tokens`, { name: 't' }).expect(201);
    const s = await openSse(portHttpA, {
      Authorization: `Bearer ${(token.body as { token: string }).token}`,
    });
    expect([401, 403]).toContain(s.status);
    s.close();
  });

  it('caps the streams one user can hold open', async () => {
    const { call } = await worldA.admin();
    const held: Sse[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i += 1) {
      held.push(await sse(portHttpA, call));
      expect(held[i]?.status).toBe(200);
    }
    const over = await openSse(portHttpA, {
      Cookie: (call as unknown as { cookie: string }).cookie,
    });
    expect(over.status).toBe(429);
    over.close();

    // Closing one makes room.
    held[0]?.close();
    await quiet(200);
    const again = await sse(portHttpA, call);
    expect(again.status).toBe(200);
  });

  it('ends a stream when its session ends', async () => {
    streamOptions.sessionCheckMs = 100;
    const { call } = await worldA.admin();
    const watcher = await sse(portHttpA, call);
    expect(watcher.status).toBe(200);

    await call('post', '/auth/logout').expect(204);
    await Promise.race([
      watcher.closed,
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(new Error('the stream outlived its session'));
        }, 3_000),
      ),
    ]);
  });
});
