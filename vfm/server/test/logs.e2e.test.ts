import 'reflect-metadata';

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GatewayService } from '../src/gateway/gateway.service';
import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import { LogSessionEndReason } from '../src/gateway/pb/vfm/agent/v1/logs';
import type { ServerMessage } from '../src/gateway/pb/vfm/agent/v1/gateway';
import { logStreamOptions } from '../src/logs/log-sessions.controller';
import { logOptions } from '../src/logs/log-sessions.service';
import { hello, makeClient, openStream, type OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * M5 day 30: live log sessions (PLAN.md §5.6, §7.2). The agent is a scripted gRPC client
 * that plays the part of the Go streamer; the browser is a raw HTTP client reading SSE.
 * Two control-plane replicas share Redis and Postgres: the agent connects to one and the
 * browser to the other, because a session must not care which replica holds which.
 */
const K = ResourceKind;
const MARKER = 'CANARY-line-7c2e91';

interface Sse {
  status: number;
  events: { event: string; data: Record<string, string> }[];
  closed: Promise<void>;
  close: () => void;
  text: () => string;
  waitFor: (pred: (e: Sse['events'][number]) => boolean, ms?: number) => Promise<void>;
}

function openSse(port: number, path: string, cookie: string): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { Cookie: cookie } }, (res) => {
      const events: Sse['events'] = [];
      const waiters: (() => void)[] = [];
      let buffer = '';
      let finish: () => void = () => undefined;
      const closed = new Promise<void>((r) => {
        finish = r;
      });
      res.setEncoding('utf8');
      res.on('data', (piece: string) => {
        buffer += piece;
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event !== undefined && data !== undefined) {
            events.push({ event, data: JSON.parse(data) as Record<string, string> });
            for (const w of waiters.splice(0)) {
              w();
            }
          }
        }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
      resolve({
        status: res.statusCode ?? 0,
        events,
        closed,
        close: () => {
          req.destroy();
        },
        text: () =>
          events
            .filter((e) => e.event === 'chunk')
            .map((e) => e.data.text)
            .join(''),
        waitFor: async (pred, ms = 5_000) => {
          const deadline = Date.now() + ms;
          while (!events.some(pred)) {
            const left = deadline - Date.now();
            if (left <= 0) {
              throw new Error(`timed out; got ${JSON.stringify(events)}`);
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
      });
    });
    req.on('error', reject);
  });
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('live log sessions (e2e, two replicas)', () => {
  let web: TestApp; // the replica the browser talks to
  let gw: TestApp; // the replica the agent is connected to
  let world: World;
  let webPort = 0;
  let gwPort = 0;
  const opened: Sse[] = [];

  beforeAll(async () => {
    web = await createTestApp({ gateway: true });
    gw = await createTestApp({ gateway: true });
    world = new World(web);
    await world.init();
    await web.app.listen(0, '127.0.0.1');
    webPort = ((web.app.getHttpServer() as http.Server).address() as AddressInfo).port;
    gwPort = gw.app.get(GatewayService).boundPort;
  }, 90_000);

  afterAll(async () => {
    for (const s of opened) {
      s.close();
    }
    world.close();
    await gw.close();
    await web.close();
  });

  const defaults = { ...logOptions };
  const streamDefaults = { ...logStreamOptions };
  beforeEach(async () => {
    await web.reset();
    Object.assign(logOptions, defaults);
    Object.assign(logStreamOptions, streamDefaults);
  });

  async function setup(policy: Record<string, unknown> = {}) {
    const { call, orgId, userId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await connect(agent, policy);
    return {
      call,
      orgId,
      userId,
      agent,
      stream,
      base: `/orgs/${orgId}/clusters/${agent.clusterId}`,
    };
  }

  async function connect(agent: Agent, policy: Record<string, unknown> = {}): Promise<OpenStream> {
    const stream = openStream(makeClient(gwPort, world.caPem, agent.cert, world.clients));
    const base = hello().hello;
    stream.send({
      ...hello({
        clusterFingerprint: `f3a1c2d4-kube-system-uid-0001-${agent.name}`,
        policy: { ...base.policy, ...policy },
      }),
    });
    const ack = await stream.next();
    expect(ack.helloAck).toBeDefined();
    return stream;
  }

  /** The next message of a kind, skipping others the control plane sends (resync, scope). */
  async function nextOf(stream: OpenStream, pick: (m: ServerMessage) => unknown, ms = 5_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error('timed out waiting for the wanted message');
      }
      const message = await stream.next(left);
      const found = pick(message);
      if (found !== undefined) {
        return found;
      }
    }
  }

  const start = (call: Call, base: string, body: object = {}) =>
    call('post', `${base}/log-sessions`, {
      namespace: 'shop',
      pod: 'web-1',
      container: 'app',
      ...body,
    });

  const cookieOf = (call: Call): string => (call as unknown as { cookie: string }).cookie;

  const watch = async (call: Call, base: string, id: string): Promise<Sse> => {
    const s = await openSse(webPort, `/api/v1${base}/log-sessions/${id}/stream`, cookieOf(call));
    opened.push(s);
    return s;
  };

  const chunk = (id: string, sequence: number, text: string | Uint8Array) => ({
    messageId: `c${sequence.toString()}`,
    logChunk: {
      sessionId: id,
      sequence,
      data: typeof text === 'string' ? Buffer.from(text) : text,
      eof: false,
    },
  });

  const ended = (id: string, reason: LogSessionEndReason, message = '') => ({
    messageId: 'end',
    logEnded: { sessionId: id, reason, message },
  });

  async function member(call: Call, orgId: string, agent: Agent, role: string, scope: object) {
    const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@acme.test`;
    const user = await world.member(call, orgId, email);
    await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
      subjectType: 'USER',
      subjectId: user.userId,
      role,
      scope,
    }).expect(201);
    return user;
  }

  describe('the whole path', () => {
    it('asks the agent only once the stream is open, then relays lines in order', async () => {
      const s = await setup();
      const created = await start(s.call, s.base, { tailLines: 50, timestamps: true }).expect(201);
      const id = (created.body as { sessionId: string }).sessionId;
      expect(created.body).toMatchObject({ streamUrl: `log-sessions/${id}/stream` });

      // Nothing has been asked of the agent: nobody is there to receive it yet.
      await expect(s.stream.next(300)).rejects.toThrow(/timed out/);

      const browser = await watch(s.call, s.base, id);
      expect(browser.status).toBe(200);
      const asked = (await nextOf(s.stream, (m) => m.startLogs)) as NonNullable<
        ServerMessage['startLogs']
      >;
      expect(asked).toMatchObject({
        sessionId: id,
        namespace: 'shop',
        pod: 'web-1',
        container: 'app',
        follow: true,
        tailLines: 50,
        timestamps: true,
        previous: false,
      });

      s.stream.send(chunk(id, 0, 'first line\n'));
      s.stream.send(chunk(id, 1, 'second line\n'));
      await browser.waitFor((e) => e.event === 'chunk' && e.data.text === 'second line\n');
      expect(browser.text()).toBe('first line\nsecond line\n');

      s.stream.send(ended(id, LogSessionEndReason.LOG_SESSION_END_REASON_COMPLETED, 'done'));
      await browser.waitFor((e) => e.event === 'ended');
      expect(browser.events.at(-1)).toEqual({
        event: 'ended',
        data: { reason: 'completed', message: 'done' },
      });
      await browser.closed;
      s.stream.cancel();
    });

    it('works when the browser and the agent are on different replicas', async () => {
      // `setup` connected the agent to `gw`; the browser's requests go to `web`. Everything
      // above already crosses; this one checks the stop travels the other way.
      const s = await setup();
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      const browser = await watch(s.call, s.base, id);
      await nextOf(s.stream, (m) => m.startLogs);

      await s.call('delete', `${s.base}/log-sessions/${id}`).expect(204);
      const stopped = (await nextOf(s.stream, (m) => m.stopLogs)) as { sessionId: string };
      expect(stopped.sessionId).toBe(id);
      await browser.waitFor((e) => e.event === 'ended' && e.data.reason === 'stopped');
      // Gone for good.
      await s.call('delete', `${s.base}/log-sessions/${id}`).expect(404);
      await s.call('get', `${s.base}/log-sessions/${id}/stream`).expect(404);
      s.stream.cancel();
    });

    it('decodes a character that arrives in two chunks, and survives bytes that are not text', async () => {
      const s = await setup();
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      const browser = await watch(s.call, s.base, id);
      await nextOf(s.stream, (m) => m.startLogs);

      const euro = Buffer.from('€'); // three bytes
      s.stream.send(chunk(id, 0, Buffer.concat([Buffer.from('a'), euro.subarray(0, 1)])));
      s.stream.send(chunk(id, 1, Buffer.concat([euro.subarray(1), Buffer.from('b\n')])));
      s.stream.send(chunk(id, 2, new Uint8Array([0xff, 0xfe, 0x0a])));
      await browser.waitFor(
        (e) =>
          e.event === 'chunk' &&
          (e.data.text ?? '').endsWith('\n') &&
          (e.data.text ?? '').length > 1,
      );
      expect(browser.text().startsWith('a€b\n')).toBe(true);
      expect(browser.events.every((e) => e.event === 'chunk')).toBe(true);
      s.stream.cancel();
    });

    it('relays why the agent ended a session, and closes the stream', async () => {
      const cases: [LogSessionEndReason, string][] = [
        [LogSessionEndReason.LOG_SESSION_END_REASON_POD_GONE, 'pod_gone'],
        [LogSessionEndReason.LOG_SESSION_END_REASON_EVICTED_BY_LIMIT, 'evicted'],
        [LogSessionEndReason.LOG_SESSION_END_REASON_TIMEOUT, 'timeout'],
        [LogSessionEndReason.LOG_SESSION_END_REASON_DENIED_BY_POLICY, 'denied'],
        [LogSessionEndReason.LOG_SESSION_END_REASON_ERROR, 'error'],
      ];
      const s = await setup();
      for (const [reason, name] of cases) {
        const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
          .sessionId;
        const browser = await watch(s.call, s.base, id);
        await nextOf(s.stream, (m) => m.startLogs);
        s.stream.send(ended(id, reason, 'line\none\u0007 of\ttext'));
        await browser.waitFor((e) => e.event === 'ended');
        expect(browser.events.at(-1)?.data).toEqual({ reason: name, message: 'line one  of text' });
        await browser.closed;
      }
      s.stream.cancel();
    });
  });

  describe('who may start one', () => {
    it('refuses a namespace the person has no logs permission in, and nothing reaches the agent', async () => {
      const s = await setup();
      const dev = await member(s.call, s.orgId, s.agent, 'OPERATOR', {
        type: 'NAMESPACES',
        namespaces: ['dev'],
      });
      await start(dev.call, s.base, { namespace: 'dev', pod: 'api-1' }).expect(201);
      await start(dev.call, s.base, { namespace: 'prod' }).expect(403);
      await expect(s.stream.next(300)).rejects.toThrow(/timed out/);
      s.stream.cancel();
    });

    it('refuses a role without logs:read, and a person with no access to the cluster', async () => {
      const s = await setup();
      const viewer = await member(s.call, s.orgId, s.agent, 'VIEWER', { type: 'CLUSTER' });
      await start(viewer.call, s.base).expect(403);

      const outsider = await world.member(s.call, s.orgId, 'outsider@acme.test');
      await start(outsider.call, s.base).expect(404);
      s.stream.cancel();
    });

    it('keeps a session to the person who started it', async () => {
      const s = await setup();
      const other = await member(s.call, s.orgId, s.agent, 'OPERATOR', { type: 'CLUSTER' });
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      await other.call('get', `${s.base}/log-sessions/${id}/stream`).expect(404);
      await other.call('delete', `${s.base}/log-sessions/${id}`).expect(404);
      // Still running for its owner.
      const browser = await watch(s.call, s.base, id);
      expect(browser.status).toBe(200);
      s.stream.cancel();
    });

    it('does not let a session be used through another cluster or organization path', async () => {
      const s = await setup();
      const second = await world.agent(s.call, s.orgId, 'staging');
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      await s
        .call('get', `/orgs/${s.orgId}/clusters/${second.clusterId}/log-sessions/${id}/stream`)
        .expect(404);
      s.stream.cancel();
    });

    it('is for browser sessions: an API token is refused on every route', async () => {
      const s = await setup();
      const minted = await s.call('post', `/orgs/${s.orgId}/tokens`, { name: 'ci' }).expect(201);
      const secret = (minted.body as { token: string }).token;
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      const withToken = (method: 'get' | 'post' | 'delete', path: string) =>
        web.api()[method](`/api/v1${s.base}${path}`).set('Authorization', `Bearer ${secret}`);
      await withToken('post', '/log-sessions')
        .send({ namespace: 'shop', pod: 'web-1' })
        .expect(403);
      await withToken('get', `/log-sessions/${id}/stream`).expect(403);
      await withToken('delete', `/log-sessions/${id}`).expect(403);
      await withToken('get', '/log-shortcuts').expect(403);
      s.stream.cancel();
    });

    it('validates what it is asked for', async () => {
      const s = await setup();
      for (const body of [
        { namespace: 'Shop' },
        { pod: '../x' },
        { container: 'a b' },
        { tailLines: 100_000 },
        { sinceSeconds: 0 },
        { follow: true },
      ]) {
        await start(s.call, s.base, body).expect(422);
      }
      s.stream.cancel();
    });
  });

  describe('the agent’s own policy, checked here as well as there', () => {
    it('refuses everything when the policy turns streaming off, with the reason', async () => {
      const s = await setup({ allowLogStreaming: false });
      const res = await start(s.call, s.base).expect(403);
      expect(JSON.stringify(res.body)).toMatch(/does not allow streaming logs/);
      await expect(s.stream.next(300)).rejects.toThrow(/timed out/);

      const access = await s.call('get', `${s.base}/access`).expect(200);
      expect(access.body.access['logs:read']).toBe('none');
      expect(access.body.blocked['logs:read']).toMatch(/does not allow streaming logs/);
      s.stream.cancel();
    });

    it('refuses a denied namespace and only that one', async () => {
      const s = await setup({ logStreamDeniedNamespaces: ['payments'] });
      const res = await start(s.call, s.base, { namespace: 'payments' }).expect(403);
      expect(JSON.stringify(res.body)).toContain('payments');
      await start(s.call, s.base, { namespace: 'shop' }).expect(201);
      s.stream.cancel();
    });

    it('says so when the agent is not connected', async () => {
      const { call, orgId } = await world.admin();
      const agent = await world.agent(call, orgId, 'offline');
      const res = await start(call, `/orgs/${orgId}/clusters/${agent.clusterId}`).expect(409);
      expect(JSON.stringify(res.body)).toMatch(/not connected/);
    });
  });

  describe('limits and clean-up', () => {
    it('limits how many sessions one person holds open', async () => {
      logOptions.maxPerUser = 2;
      const s = await setup();
      const first = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      await start(s.call, s.base).expect(201);
      await start(s.call, s.base).expect(429);
      // Closing one makes room.
      await s.call('delete', `${s.base}/log-sessions/${first}`).expect(204);
      await start(s.call, s.base).expect(201);
      s.stream.cancel();
    });

    it('ends a session nobody is watching, and tells the agent', async () => {
      Object.assign(logOptions, { idleTimeoutMs: 400, sweepMs: 50, aliveTtlMs: 200 });
      logStreamOptions.pingMs = 60_000;
      const s = await setup();
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      const browser = await watch(s.call, s.base, id);
      await nextOf(s.stream, (m) => m.startLogs);

      browser.close();
      const stopped = (await nextOf(s.stream, (m) => m.stopLogs, 5_000)) as { sessionId: string };
      expect(stopped.sessionId).toBe(id);
      s.stream.cancel();
    });

    it('forgets a session that nobody ever opened, without bothering the agent', async () => {
      Object.assign(logOptions, { waitingTtlMs: 200, idleTimeoutMs: 300, sweepMs: 50 });
      const s = await setup();
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      await pause(900);
      await s.call('get', `${s.base}/log-sessions/${id}/stream`).expect(404);
      await expect(s.stream.next(200)).rejects.toThrow(/timed out/);
      // Nothing of it is left in Redis either: not its record, not its place in the lists.
      const left = await web.redis.connection.keys('vfm:logsess:*');
      expect(left).toEqual([]);
      // And its slot is free again.
      logOptions.maxPerUser = 1;
      await start(s.call, s.base).expect(201);
      s.stream.cancel();
    });

    it('ends the stream of a session when the agent disconnects', async () => {
      const s = await setup();
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      const browser = await watch(s.call, s.base, id);
      await nextOf(s.stream, (m) => m.startLogs);

      s.stream.cancel();
      await s.stream.ended;
      await browser.waitFor((e) => e.event === 'ended');
      expect(browser.events.at(-1)?.data.reason).toBe('error');
      expect(browser.events.at(-1)?.data.message).toMatch(/disconnected/);
    });

    it('ends the stream when the person loses the permission', async () => {
      logStreamOptions.recheckMs = 100;
      const s = await setup();
      const user = await member(s.call, s.orgId, s.agent, 'OPERATOR', { type: 'CLUSTER' });
      const id = ((await start(user.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      const browser = await watch(user.call, s.base, id);
      await nextOf(s.stream, (m) => m.startLogs);

      const bindings = await s
        .call('get', `/clusters/${s.agent.clusterId}/role-bindings`)
        .expect(200);
      const mine = (
        bindings.body as { bindings: { id: string; subjectId: string }[] }
      ).bindings.find((b) => b.subjectId === user.userId);
      await s
        .call('delete', `/clusters/${s.agent.clusterId}/role-bindings/${mine?.id ?? 'missing'}`)
        .expect(204);

      await browser.waitFor((e) => e.event === 'ended' && e.data.reason === 'revoked');
      expect((await nextOf(s.stream, (m) => m.stopLogs)) as object).toBeDefined();
      s.stream.cancel();
    });

    it('tells an agent to stop a session the control plane does not know', async () => {
      const s = await setup();
      s.stream.send(chunk('00000000-0000-4000-8000-000000000000', 0, 'orphan\n'));
      const stop = (await nextOf(s.stream, (m) => m.stopLogs)) as { sessionId: string };
      expect(stop.sessionId).toBe('00000000-0000-4000-8000-000000000000');
      s.stream.cancel();
    });

    it('ignores a chunk from an agent for a session that is another cluster’s', async () => {
      const s = await setup();
      const other = await world.agent(s.call, s.orgId, 'staging');
      const otherStream = await connect(other);

      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      const browser = await watch(s.call, s.base, id);
      await nextOf(s.stream, (m) => m.startLogs);

      otherStream.send(chunk(id, 0, 'from the wrong cluster\n'));
      s.stream.send(chunk(id, 0, 'from the right one\n'));
      await browser.waitFor((e) => e.event === 'chunk');
      expect(browser.text()).toBe('from the right one\n');
      otherStream.cancel();
      s.stream.cancel();
    });

    it('ends a session whose agent sends more than a chunk may hold', async () => {
      const s = await setup();
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      const browser = await watch(s.call, s.base, id);
      await nextOf(s.stream, (m) => m.startLogs);
      s.stream.send(chunk(id, 0, new Uint8Array(64 * 1024 + 1).fill(97)));
      await browser.waitFor((e) => e.event === 'ended');
      expect(browser.text()).toBe('');
      s.stream.cancel();
    });
  });

  describe('what is kept', () => {
    it('audits the start with what was viewed — never what it said — and stores no line anywhere', async () => {
      const s = await setup();
      const id = ((await start(s.call, s.base).expect(201)).body as { sessionId: string })
        .sessionId;
      const browser = await watch(s.call, s.base, id);
      await nextOf(s.stream, (m) => m.startLogs);
      s.stream.send(chunk(id, 0, `password=${MARKER}\n`));
      await browser.waitFor((e) => e.event === 'chunk');
      await s.call('delete', `${s.base}/log-sessions/${id}`).expect(204);
      await browser.waitFor((e) => e.event === 'ended');

      const audit = await s.call('get', `/orgs/${s.orgId}/audit?action=POST`).expect(200);
      const events = (
        audit.body as {
          events: {
            action: string;
            targetId: string | null;
            details: Record<string, unknown>;
            outcome: string;
            actorId: string | null;
          }[];
        }
      ).events;
      const started = events.find((e) => e.action.endsWith('/log-sessions'));
      expect(started).toMatchObject({
        targetId: id,
        outcome: 'SUCCESS',
        actorId: s.userId,
        details: {
          namespace: 'shop',
          pod: 'web-1',
          container: 'app',
          previous: false,
          status: 201,
        },
      });

      const tables = await web.prisma.unscoped('t', () =>
        web.prisma.$queryRawUnsafe<{ table_name: string }[]>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
        ),
      );
      for (const { table_name } of tables) {
        const hits = await web.prisma.unscoped('t', () =>
          web.prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM "${table_name}" t WHERE t::text LIKE $1`,
            `%${MARKER}%`,
          ),
        );
        expect(hits[0]?.n, `table ${table_name}`).toBe(0n);
      }
      s.stream.cancel();
    });

    it('audits a refusal too, with what was asked for', async () => {
      const s = await setup({ logStreamDeniedNamespaces: ['payments'] });
      await start(s.call, s.base, { namespace: 'payments', pod: 'ledger-1' }).expect(403);
      const audit = await s.call('get', `/orgs/${s.orgId}/audit?action=POST`).expect(200);
      const denied = (
        audit.body as {
          events: { action: string; outcome: string; details: Record<string, unknown> }[];
        }
      ).events.find((e) => e.action.endsWith('/log-sessions') && e.outcome === 'DENIED');
      expect(denied?.details).toMatchObject({ namespace: 'payments', pod: 'ledger-1' });
      s.stream.cancel();
    });
  });

  describe('Velero’s own pods', () => {
    const pod = (
      name: string,
      owner: { kind: string; name: string },
      container: string,
      node: string,
    ) =>
      resource(name, {
        kind: K.RESOURCE_KIND_POD,
        namespace: 'velero',
        phase: 'Running',
        spec: { nodeName: node, owner },
        status: {
          readyCount: 1,
          containerCount: 1,
          containerStatuses: [{ name: container, state: 'running' }],
        },
      });

    async function withVelero() {
      const s = await setup();
      s.stream.send({
        messageId: 's',
        snapshot: {
          snapshotId: 's1',
          sequence: 0,
          last: true,
          items: [
            resource('default', {
              kind: K.RESOURCE_KIND_BACKUP_STORAGE_LOCATION,
              namespace: 'velero',
              phase: 'Available',
              spec: { provider: 'aws' },
            }),
            pod('velero-6d8f-x1', { kind: 'ReplicaSet', name: 'velero-6d8f' }, 'velero', 'n1'),
            pod('node-agent-b', { kind: 'DaemonSet', name: 'node-agent' }, 'node-agent', 'n2'),
            pod('node-agent-a', { kind: 'DaemonSet', name: 'node-agent' }, 'node-agent', 'n1'),
            pod('grafana-1', { kind: 'ReplicaSet', name: 'grafana-5' }, 'grafana', 'n1'),
          ],
        },
      });
      for (let i = 0; i < 100; i += 1) {
        const c = await web.prisma.unscoped('t', () =>
          web.prisma.cluster.findUniqueOrThrow({ where: { id: s.agent.clusterId } }),
        );
        if (c.inventorySnapshotId === 's1') {
          break;
        }
        await pause(25);
      }
      return s;
    }

    it('offers the server and each node agent for one click', async () => {
      const s = await withVelero();
      const res = await s.call('get', `${s.base}/log-shortcuts`).expect(200);
      expect(res.body).toEqual({
        namespace: 'velero',
        server: [{ pod: 'velero-6d8f-x1', container: 'velero', node: 'n1' }],
        nodeAgent: [
          { pod: 'node-agent-a', container: 'node-agent', node: 'n1' },
          { pod: 'node-agent-b', container: 'node-agent', node: 'n2' },
        ],
      });
      s.stream.cancel();
    });

    it('is empty before Velero’s namespace is known, and refused without logs access there', async () => {
      const s = await withVelero();
      const bare = await world.agent(s.call, s.orgId, 'bare');
      const none = await s
        .call('get', `/orgs/${s.orgId}/clusters/${bare.clusterId}/log-shortcuts`)
        .expect(200);
      expect(none.body).toEqual({ namespace: null, server: [], nodeAgent: [] });

      const dev = await member(s.call, s.orgId, s.agent, 'OPERATOR', {
        type: 'NAMESPACES',
        namespaces: ['dev'],
      });
      await dev.call('get', `${s.base}/log-shortcuts`).expect(403);
      s.stream.cancel();
    });

    it('starts a session on the pod it offers', async () => {
      const s = await withVelero();
      const id = (
        (
          await start(s.call, s.base, {
            namespace: 'velero',
            pod: 'velero-6d8f-x1',
            container: 'velero',
          }).expect(201)
        ).body as { sessionId: string }
      ).sessionId;
      await watch(s.call, s.base, id);
      const asked = (await nextOf(s.stream, (m) => m.startLogs)) as { pod: string };
      expect(asked.pod).toBe('velero-6d8f-x1');
      s.stream.cancel();
    });
  });

  describe('a previous container', () => {
    it('reads what the last container wrote once and ends, never following', async () => {
      const s = await setup();
      const id = (
        (await start(s.call, s.base, { previous: true, sinceSeconds: 600 }).expect(201)).body as {
          sessionId: string;
        }
      ).sessionId;
      await watch(s.call, s.base, id);
      const asked = (await nextOf(s.stream, (m) => m.startLogs)) as {
        previous: boolean;
        follow: boolean;
        sinceSeconds: number;
      };
      expect(asked).toMatchObject({ previous: true, follow: false, sinceSeconds: 600 });
      s.stream.cancel();
    });
  });
});
