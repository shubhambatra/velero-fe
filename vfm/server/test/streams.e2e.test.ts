import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { status as grpcStatus } from '@grpc/grpc-js';
import type { AgentGatewayClient } from '../src/gateway/pb/vfm/agent/v1/gateway';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CaService } from '../src/ca/ca.service';
import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env.schema';
import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { ResourceEventType, ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import { GatewayService } from '../src/gateway/gateway.service';
import { StreamsService } from '../src/streams/streams.service';
import {
  enrollWith,
  errorOf,
  hello,
  keypair,
  makeClient,
  openStream,
  type AgentCert,
} from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';

/**
 * M2 day 13 against the real thing: two control-plane replicas sharing one
 * PostgreSQL and one Redis, real gRPC streams over real mTLS, a real CA. What is
 * proven here is the behaviour of the stream — what an agent may say first, what is
 * stored from it, what happens when it goes away, and that revocation, supersession
 * and routing work across replicas.
 */
const PASSWORD = 'canopy-vellum-ratchet-82';
const FINGERPRINT = 'f3a1c2d4-kube-system-uid-0001';

// grpc status codes used below.
const ABORTED = 10;
const INVALID_ARGUMENT = 3;
const FAILED_PRECONDITION = 9;
const PERMISSION_DENIED = 7;
const DEADLINE_EXCEEDED = 4;
const UNAUTHENTICATED = 16;

describe('agent streams (e2e, two replicas)', () => {
  let a: TestApp;
  let b: TestApp;
  let streamsA: StreamsService;
  let streamsB: StreamsService;
  let portA: number;
  let portB: number;
  let caPem: string;
  const clients: AgentGatewayClient[] = [];

  beforeAll(async () => {
    a = await createTestApp({ gateway: true });
    b = await createTestApp({ gateway: true });
    streamsA = a.app.get(StreamsService);
    streamsB = b.app.get(StreamsService);
    portA = a.app.get(GatewayService).boundPort;
    portB = b.app.get(GatewayService).boundPort;
    caPem = await a.app.get(CaService).certificatePem();
  }, 90_000);

  afterAll(async () => {
    for (const client of clients) {
      client.close();
    }
    await b.close();
    await a.close();
  });

  beforeEach(async () => {
    await a.reset();
    streamsA.options.disconnectAfterMs = 45_000;
    streamsB.options.disconnectAfterMs = 45_000;
  });

  const sessionsOf = (h: TestApp): SessionService => h.app.get(SessionService);

  async function actAs(h: TestApp, userId: string) {
    const created = await sessionsOf(h).create({ userId, ip: '127.0.0.1', userAgent: 'vitest' });
    const cookie = `${SessionService.COOKIE}=${created.id}; ${SessionService.CSRF_COOKIE}=${created.csrfToken}`;
    return (method: 'get' | 'post' | 'delete', path: string, body?: object): request.Test => {
      const req = h
        .api()
        [method](`/api/v1${path}`)
        .set('Cookie', cookie)
        .set(CSRF_HEADER, created.csrfToken);
      return body === undefined ? req : req.send(body);
    };
  }

  /** An org, an enrolled cluster and its agent credentials. */
  async function enrolledAgent() {
    const setupToken = 'setup-' + Math.random().toString(36).slice(2);
    await a.redis.connection.set(
      'vfm:setup:token',
      createHash('sha256').update(setupToken, 'utf8').digest('hex'),
      'EX',
      3_600,
    );
    const user = await a
      .api()
      .post('/api/v1/auth/setup')
      .send({ token: setupToken, email: 'root@vfm.local', password: PASSWORD })
      .expect(201);
    const userId = user.body.user.id as string;
    const callA = await actAs(a, userId);
    const callB = await actAs(b, userId);

    const org = await callA('post', '/orgs', { name: 'Acme', slug: 'acme' }).expect(201);
    const orgId = org.body.id as string;
    await callA('post', '/me/active-org', { orgId }).expect(204);
    await callB('post', '/me/active-org', { orgId }).expect(204);
    const created = await callA('post', `/orgs/${orgId}/clusters`, { name: 'prod-eu' }).expect(201);
    const clusterId = created.body.cluster.id as string;

    const keys = await keypair();
    const response = await enrollWith(
      makeClient(portA, caPem, undefined, clients),
      created.body.bootstrapToken as string,
      keys.csrPem,
      FINGERPRINT,
    );
    const cert: AgentCert = {
      chain: Buffer.from(response.certificatePem).toString(),
      key: keys.privateKeyPem,
    };
    return { callA, callB, orgId, clusterId, cert };
  }

  const stateOf = (clusterId: string) =>
    a.prisma.unscoped('test', () =>
      a.prisma.cluster.findUniqueOrThrow({ where: { id: clusterId } }),
    );

  async function eventually<T>(
    what: string,
    read: () => Promise<T>,
    ok: (v: T) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const value = await read();
      if (ok(value)) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function connect(port: number, cert: AgentCert, helloOverrides?: Record<string, unknown>) {
    const stream = openStream(makeClient(port, caPem, cert, clients));
    stream.send(hello(helloOverrides));
    return stream;
  }

  describe('Hello', () => {
    it('is acknowledged with the server’s limits, and the cluster becomes CONNECTED with its details', async () => {
      const { callA, orgId, clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert);

      const ack = (await stream.next()).helloAck;
      expect(ack?.acceptedProtocolVersion).toBe(1);
      expect(ack?.config?.heartbeatInterval?.seconds).toBe(15);
      expect(ack?.config?.maxMessageBytes).toBe(4 * 1024 * 1024);

      const cluster = await eventually(
        'CONNECTED',
        () => stateOf(clusterId),
        (c) => c.status === 'CONNECTED',
      );
      expect(cluster.veleroVersion).toBe('v1.18.4');
      expect(cluster.k8sVersion).toBe('v1.31.0');
      expect(cluster.veleroPlugins).toEqual([{ name: 'velero.io/aws', kind: 'ObjectStore' }]);
      expect(cluster.agentPolicy).toMatchObject({ allowRestore: true, readOnly: false });
      expect(cluster.chartVersion).toBe('0.0.1');
      expect(cluster.imageTag).toBe('sha-abc');
      expect(cluster.protocolVersion).toBe(1);
      expect(cluster.lastSeenAt).not.toBeNull();
      expect(await streamsA.locate(clusterId)).toBe(streamsA.replicaId);

      // The API tells the UI the agent's chart is older than this control plane's.
      const shown = await callA('get', `/orgs/${orgId}/clusters/${clusterId}`).expect(200);
      expect(shown.body.chartVersion).toBe('0.0.1');
      expect(shown.body.agentUpdateAvailable).toBe(true);
      stream.cancel();
    });

    it.each([['a heartbeat first', { messageId: 'x', heartbeat: {} }, INVALID_ARGUMENT]])(
      'refuses %s',
      async (_name, first, code) => {
        const { cert } = await enrolledAgent();
        const stream = openStream(makeClient(portA, caPem, cert, clients));
        stream.send(first);
        expect(((await stream.ended) as { code: number }).code).toBe(code);
      },
    );

    it('refuses an unsupported protocol version and does not mark the cluster connected', async () => {
      const { clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert, { protocolVersion: 99 });
      const end = (await stream.ended) as { code: number; details: string };
      expect(end.code).toBe(FAILED_PRECONDITION);
      expect(end.details).toContain('99');
      expect((await stateOf(clusterId)).status).toBe('ENROLLED');
    });

    it('refuses an agent whose fingerprint is not the cluster it enrolled in', async () => {
      const { clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert, { clusterFingerprint: 'a-different-cluster' });
      expect(((await stream.ended) as { code: number }).code).toBe(FAILED_PRECONDITION);
      expect((await stateOf(clusterId)).status).toBe('ENROLLED');
    });

    it('refuses a second Hello on the same stream', async () => {
      const { cert } = await enrolledAgent();
      const stream = connect(portA, cert);
      await stream.next();
      stream.send(hello());
      expect(((await stream.ended) as { code: number }).code).toBe(INVALID_ARGUMENT);
    });

    it('stores a hostile Hello bounded and clean, and an absent policy as restricted', async () => {
      const { clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert, {
        agentVersion: '1.0\u0007\u001b[31m' + 'A'.repeat(10_000),
        kubernetesVersion: '<script>alert(1)</script>',
        velero: {
          serverVersion: 'v1.18.4',
          plugins: Array.from({ length: 500 }, (_, i) => ({
            name: `p${i.toString()}`,
            kind: 'ObjectStore',
          })),
        },
        capabilities: Array.from({ length: 500 }, (_, i) => `cap-${i.toString()}`),
        policy: undefined,
      });
      await stream.next();

      const cluster = await eventually(
        'CONNECTED',
        () => stateOf(clusterId),
        (c) => c.status === 'CONNECTED',
      );
      expect(cluster.agentVersion?.length).toBeLessThanOrEqual(128);
      // eslint-disable-next-line no-control-regex
      expect(cluster.agentVersion).not.toMatch(/[\u0000-\u001f]/);
      expect((cluster.veleroPlugins as unknown[]).length).toBe(50);
      expect((cluster.capabilities as unknown[]).length).toBe(50);
      // "No policy reported" must read as locked down, never as open.
      expect(cluster.agentPolicy).toMatchObject({
        allowRestore: false,
        allowBslWrite: false,
        allowLogStreaming: false,
        readOnly: true,
      });
      stream.cancel();
    });
  });

  describe('liveness', () => {
    it('updates last_seen_at on every heartbeat', async () => {
      const { clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert);
      await stream.next();
      const first = (
        await eventually(
          'CONNECTED',
          () => stateOf(clusterId),
          (c) => c.status === 'CONNECTED',
        )
      ).lastSeenAt as Date;

      await new Promise((r) => setTimeout(r, 30));
      stream.send({ messageId: 'hb', heartbeat: {} });
      const later = await eventually(
        'a newer last_seen_at',
        () => stateOf(clusterId),
        (c) => (c.lastSeenAt?.getTime() ?? 0) > first.getTime(),
      );
      expect(later.status).toBe('CONNECTED');
      stream.cancel();
    });

    it('marks the cluster DISCONNECTED and clears its route when the agent leaves, and CONNECTED again on return', async () => {
      const { clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert);
      await stream.next();
      await eventually(
        'CONNECTED',
        () => stateOf(clusterId),
        (c) => c.status === 'CONNECTED',
      );

      stream.end();
      await stream.ended;
      await eventually(
        'DISCONNECTED',
        () => stateOf(clusterId),
        (c) => c.status === 'DISCONNECTED',
      );
      expect(await streamsA.locate(clusterId)).toBeUndefined();

      const again = connect(portA, cert);
      await again.next();
      await eventually(
        'CONNECTED again',
        () => stateOf(clusterId),
        (c) => c.status === 'CONNECTED',
      );
      again.cancel();
    });

    it('disconnects an agent that goes silent', async () => {
      const { clusterId, cert } = await enrolledAgent();
      streamsA.options.disconnectAfterMs = 300;
      const stream = connect(portA, cert);
      await stream.next();

      const end = (await stream.ended) as { code: number };
      expect(end.code).toBe(DEADLINE_EXCEEDED);
      await eventually(
        'DISCONNECTED',
        () => stateOf(clusterId),
        (c) => c.status === 'DISCONNECTED',
      );
    });

    it('keeps an agent that keeps talking, however long the window is not', async () => {
      const { clusterId, cert } = await enrolledAgent();
      streamsA.options.disconnectAfterMs = 400;
      const stream = connect(portA, cert);
      await stream.next();
      for (let i = 0; i < 5; i += 1) {
        await new Promise((r) => setTimeout(r, 150));
        stream.send({ messageId: `hb${i.toString()}`, heartbeat: {} });
      }
      expect((await stateOf(clusterId)).status).toBe('CONNECTED');
      stream.cancel();
    });
  });

  describe('inventory messages before the ingest exists', () => {
    it('are accepted and ignored without disturbing the stream', async () => {
      const { clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert);
      await stream.next();

      stream.send({
        messageId: 's1',
        snapshot: {
          snapshotId: 'snap-1',
          sequence: 0,
          last: true,
          items: [
            {
              kind: ResourceKind.RESOURCE_KIND_BACKUP,
              namespace: 'velero',
              name: 'b1',
              uid: 'u',
              resourceVersion: '1',
              objectJson: Buffer.from('{}'),
            },
          ],
        },
      });
      stream.send({
        messageId: 'e1',
        events: {
          snapshotId: 'snap-1',
          batchSequence: 1,
          events: [
            {
              type: ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT,
              item: { kind: ResourceKind.RESOURCE_KIND_BACKUP, name: 'b2' },
            },
          ],
        },
      });
      // Still serving: a heartbeat afterwards is processed and the cluster stays CONNECTED.
      await new Promise((r) => setTimeout(r, 100));
      const before = (await stateOf(clusterId)).lastSeenAt;
      stream.send({ messageId: 'hb', heartbeat: {} });
      const later = await eventually(
        'a newer last_seen_at',
        () => stateOf(clusterId),
        (c) => (c.lastSeenAt?.getTime() ?? 0) > (before?.getTime() ?? 0),
      );
      expect(later.status).toBe('CONNECTED');
      stream.cancel();
    });
  });

  describe('the sweeper', () => {
    it('marks a CONNECTED cluster with a stale last_seen_at and no route, and leaves a live one alone', async () => {
      const live = await enrolledAgent();
      const stream = connect(portA, live.cert);
      await stream.next();
      await eventually(
        'CONNECTED',
        () => stateOf(live.clusterId),
        (c) => c.status === 'CONNECTED',
      );

      const old = new Date(Date.now() - 3_600_000);
      // Stale in the database but still routed: its replica is alive, so leave it.
      await a.prisma.unscoped('test', () =>
        a.prisma.cluster.update({ where: { id: live.clusterId }, data: { lastSeenAt: old } }),
      );
      await streamsA.sweep();
      expect((await stateOf(live.clusterId)).status).toBe('CONNECTED');

      // The replica died: no route. Now it is marked.
      await a.redis.connection.del(`vfm:agent:${live.clusterId}`);
      await a.redis.connection.del('vfm:gateway:sweeper');
      expect(await streamsA.sweep()).toBe(1);
      expect((await stateOf(live.clusterId)).status).toBe('DISCONNECTED');
      stream.cancel();
    });

    it('lets only one replica sweep at a time', async () => {
      await a.redis.connection.del('vfm:gateway:sweeper');
      await streamsA.sweep();
      expect(await streamsB.sweep()).toBe(0);
    });
  });

  describe('revocation closes live streams', () => {
    it('disabling a cluster ends its open stream and leaves it DISABLED, not DISCONNECTED', async () => {
      const { callA, orgId, clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert);
      await stream.next();
      await eventually(
        'CONNECTED',
        () => stateOf(clusterId),
        (c) => c.status === 'CONNECTED',
      );

      await callA('post', `/orgs/${orgId}/clusters/${clusterId}/disable`).expect(200);

      expect(((await stream.ended) as { code: number }).code).toBe(PERMISSION_DENIED);
      await new Promise((r) => setTimeout(r, 100));
      expect((await stateOf(clusterId)).status).toBe('DISABLED');

      // And it cannot come back.
      const retry = openStream(makeClient(portA, caPem, cert, clients));
      retry.send(hello());
      expect(((await retry.ended) as { code: number }).code).toBe(UNAUTHENTICATED);
    });

    it('ends an open stream whose certificate was revoked even if the push to close it was lost', async () => {
      const { orgId, clusterId, cert } = await enrolledAgent();
      streamsA.options.recheckMs = 150;
      const stream = connect(portA, cert);
      await stream.next();
      // As if the Redis message that closes streams never arrived: only the database says "revoked".
      await a.prisma.inOrg(orgId, () =>
        a.prisma.agentCertificate.updateMany({
          where: { clusterId },
          data: { revokedAt: new Date() },
        }),
      );
      expect(((await stream.ended) as { code: number }).code).toBe(UNAUTHENTICATED);
      streamsA.options.recheckMs = 60_000;
    });

    it('ends an open stream whose cluster was disabled behind its back, and leaves healthy ones alone', async () => {
      const { orgId, clusterId, cert } = await enrolledAgent();
      streamsA.options.recheckMs = 100;
      const stream = connect(portA, cert);
      await stream.next();
      await new Promise((r) => setTimeout(r, 450));
      // Several re-checks have passed and the stream is still open.
      expect(
        await eventually(
          'CONNECTED',
          () => stateOf(clusterId),
          (c) => c.status === 'CONNECTED',
        ),
      ).toBeDefined();
      await a.prisma.inOrg(orgId, () =>
        a.prisma.cluster.update({ where: { id: clusterId }, data: { status: 'DISABLED' } }),
      );
      expect(((await stream.ended) as { code: number }).code).toBe(UNAUTHENTICATED);
      streamsA.options.recheckMs = 60_000;
    });

    it('deleting a cluster ends its open stream', async () => {
      const { callA, orgId, clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert);
      await stream.next();

      await callA('delete', `/orgs/${orgId}/clusters/${clusterId}`).expect(204);
      expect(((await stream.ended) as { code: number }).code).toBe(PERMISSION_DENIED);
    });

    it('rotating certificates ends the open stream', async () => {
      const { callA, orgId, clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert);
      await stream.next();

      await callA('post', `/orgs/${orgId}/clusters/${clusterId}/rotate-certificate`).expect(200);
      expect(((await stream.ended) as { code: number }).code).toBe(PERMISSION_DENIED);
    });
  });

  describe('across replicas', () => {
    it('routes: either replica knows where the agent is, and a message sent via the other arrives', async () => {
      const { clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert);
      await stream.next();

      expect(streamsA.isLocal(clusterId)).toBe(true);
      expect(streamsB.isLocal(clusterId)).toBe(false);
      expect(await streamsB.locate(clusterId)).toBe(streamsA.replicaId);

      // Sent through B, delivered by A to the agent.
      const delivered = await streamsB.send(clusterId, {
        messageId: 'via-b',
        resync: { reason: 'routing test' },
      });
      expect(delivered).toBe(true);
      const message = await stream.next();
      expect(message.resync?.reason).toBe('routing test');
      stream.cancel();
    });

    it('reports that an agent which is not connected anywhere cannot be reached', async () => {
      const { clusterId } = await enrolledAgent();
      expect(await streamsB.send(clusterId, { messageId: 'x' })).toBe(false);
    });

    it('lets the newest stream win: connecting through B ends the stream on A, and B owns the route', async () => {
      const { clusterId, cert } = await enrolledAgent();
      const onA = connect(portA, cert);
      await onA.next();

      const onB = connect(portB, cert);
      await onB.next();

      expect(((await onA.ended) as { code: number }).code).toBe(ABORTED);
      expect(await streamsA.locate(clusterId)).toBe(streamsB.replicaId);
      // The superseded stream's cleanup must not flip the live cluster to DISCONNECTED.
      await new Promise((r) => setTimeout(r, 150));
      expect((await stateOf(clusterId)).status).toBe('CONNECTED');
      expect(streamsA.isLocal(clusterId)).toBe(false);
      expect(streamsB.isLocal(clusterId)).toBe(true);
      onB.cancel();
    });

    it('lets the newest stream win on one replica too', async () => {
      const { clusterId, cert } = await enrolledAgent();
      const first = connect(portA, cert);
      await first.next();
      const second = connect(portA, cert);
      await second.next();

      expect(((await first.ended) as { code: number }).code).toBe(ABORTED);
      await new Promise((r) => setTimeout(r, 100));
      expect((await stateOf(clusterId)).status).toBe('CONNECTED');
      second.cancel();
    });

    it('revokes from a replica that does not hold the stream', async () => {
      const { callB, orgId, clusterId, cert } = await enrolledAgent();
      const stream = connect(portA, cert);
      await stream.next();

      // The administrator's request lands on B; the stream lives on A.
      await callB('post', `/orgs/${orgId}/clusters/${clusterId}/disable`).expect(200);
      expect(((await stream.ended) as { code: number }).code).toBe(PERMISSION_DENIED);
    });
  });

  describe('limits on what an agent can cost (threat model G-10, G-11)', () => {
    async function withEnv<T>(patch: Partial<Env>, run: () => Promise<T>): Promise<T> {
      const env = a.app.get<Env>(ENV);
      const before = { ...env };
      Object.assign(env, patch);
      try {
        return await run();
      } finally {
        Object.assign(env, before);
      }
    }

    it('closes a stream that sends faster than its budget, and the agent can come back', async () => {
      const { clusterId, cert } = await enrolledAgent();
      await withEnv({ AGENT_MESSAGE_BURST: 5, AGENT_MESSAGES_PER_SECOND: 1 }, async () => {
        const stream = connect(portA, cert);
        await stream.next();
        for (let i = 0; i < 30; i += 1) {
          stream.send({ messageId: `hb${i.toString()}`, heartbeat: {} });
        }
        const end = (await stream.ended) as { code: number };
        expect(end.code).toBe(grpcStatus.RESOURCE_EXHAUSTED);
      });
      // The budget is per stream: a fresh stream starts full.
      const again = connect(portA, cert);
      await again.next();
      again.send({ messageId: 'hb', heartbeat: {} });
      await eventually(
        'CONNECTED',
        () => stateOf(clusterId),
        (c) => c.status === 'CONNECTED',
      );
      again.cancel();
    });

    it('does not close a stream that stays inside its budget', async () => {
      const { cert } = await enrolledAgent();
      await withEnv({ AGENT_MESSAGE_BURST: 50, AGENT_MESSAGES_PER_SECOND: 1 }, async () => {
        const stream = connect(portA, cert);
        await stream.next();
        for (let i = 0; i < 20; i += 1) {
          stream.send({ messageId: `hb${i.toString()}`, heartbeat: {} });
        }
        await new Promise((r) => setTimeout(r, 300));
        stream.send({ messageId: 'last', heartbeat: {} });
        const early = await Promise.race([
          stream.ended.then(() => 'ended'),
          new Promise((r) =>
            setTimeout(() => {
              r('open');
            }, 300),
          ),
        ]);
        expect(early).toBe('open');
        stream.cancel();
      });
    });

    it('does not count log chunks, which have their own caps', async () => {
      const { cert } = await enrolledAgent();
      await withEnv({ AGENT_MESSAGE_BURST: 3, AGENT_MESSAGES_PER_SECOND: 1 }, async () => {
        const stream = connect(portA, cert);
        await stream.next();
        for (let i = 0; i < 40; i += 1) {
          stream.send({
            messageId: `lc${i.toString()}`,
            logChunk: {
              sessionId: 'no-such-session',
              sequence: i,
              data: Buffer.from('x'),
              eof: false,
            },
          });
        }
        const early = await Promise.race([
          stream.ended.then(() => 'ended'),
          new Promise((r) =>
            setTimeout(() => {
              r('open');
            }, 400),
          ),
        ]);
        expect(early).toBe('open');
        stream.cancel();
      });
    });

    it('limits Enroll per source address before it looks at the token', async () => {
      const keys = await keypair();
      const client = makeClient(portA, caPem, undefined, clients);
      // The window is per address and counts in Redis; start clean.
      for (const key of await a.redis.connection.keys('vfm:rl:enroll:*')) {
        await a.redis.connection.del(key);
      }
      await withEnv({ GATEWAY_ENROLL_PER_MINUTE: 3 }, async () => {
        for (let i = 0; i < 3; i += 1) {
          const error = await errorOf(
            enrollWith(client, 'not-a-real-token', keys.csrPem, FINGERPRINT),
          );
          expect(error.code).not.toBe(grpcStatus.RESOURCE_EXHAUSTED);
        }
        const refused = await errorOf(
          enrollWith(client, 'not-a-real-token', keys.csrPem, FINGERPRINT),
        );
        expect(refused.code).toBe(grpcStatus.RESOURCE_EXHAUSTED);
      });
      for (const key of await a.redis.connection.keys('vfm:rl:enroll:*')) {
        await a.redis.connection.del(key);
      }
    });

    it('caps how many enrollments run at once on a replica', async () => {
      const keys = await keypair();
      const client = makeClient(portA, caPem, undefined, clients);
      // A high per-address ceiling keeps the Redis round trip in every call: the window in which a
      // count taken after the first await would let a whole burst through.
      await withEnv(
        { GATEWAY_ENROLL_PER_MINUTE: 100_000, GATEWAY_ENROLL_MAX_INFLIGHT: 2 },
        async () => {
          const codes = await Promise.all(
            Array.from({ length: 12 }, () =>
              errorOf(enrollWith(client, 'not-a-real-token', keys.csrPem, FINGERPRINT)).then(
                (e) => e.code,
              ),
            ),
          );
          // Some are turned away because two were already running; none of the others is a server error.
          expect(codes.filter((c) => c === grpcStatus.RESOURCE_EXHAUSTED).length).toBeGreaterThan(
            0,
          );
          expect(codes.every((c) => c !== grpcStatus.INTERNAL)).toBe(true);
        },
      );
    });
  });

  it('still refuses a certificate-less Connect before any of this is reached', async () => {
    await enrolledAgent();
    const stream = openStream(makeClient(portA, caPem, undefined, clients));
    stream.send(hello());
    const end = await errorOf(stream.ended.then((e) => Promise.reject(e as Error)));
    expect((end as unknown as { code: number }).code).toBe(UNAUTHENTICATED);
  });
});
