import 'reflect-metadata';

import { createHash } from 'node:crypto';

import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { CaService } from '../src/ca/ca.service';
import { CommandsService } from '../src/commands/commands.service';
import { CommandAckState } from '../src/gateway/pb/vfm/agent/v1/command';
import { ErrorCode } from '../src/gateway/pb/vfm/agent/v1/common';
import { GatewayService } from '../src/gateway/gateway.service';
import type { AgentGatewayClient } from '../src/gateway/pb/vfm/agent/v1/gateway';
import {
  enrollWith,
  hello,
  keypair,
  makeClient,
  openStream,
  type AgentCert,
  type OpenStream,
} from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';

/**
 * M2 day 14 — the command pipeline — against real PostgreSQL, Redis, gRPC and mTLS,
 * with a fake agent that says exactly what the test tells it to. The agent side
 * (dispatcher, policy, idempotency) is tested in Go; this file proves the control
 * plane's half of the contract: what is sent, when, how many times, and what the
 * agent is and is not allowed to change.
 */
const PASSWORD = 'canopy-vellum-ratchet-82';
const FINGERPRINT = 'f3a1c2d4-kube-system-uid-0001';

describe('commands (e2e)', () => {
  let harness: TestApp;
  let commands: CommandsService;
  let port: number;
  let caPem: string;
  const clients: AgentGatewayClient[] = [];

  beforeAll(async () => {
    harness = await createTestApp({ gateway: true });
    commands = harness.app.get(CommandsService);
    port = harness.app.get(GatewayService).boundPort;
    caPem = await harness.app.get(CaService).certificatePem();
  }, 60_000);

  afterAll(async () => {
    for (const client of clients) {
      client.close();
    }
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  type Call = (method: 'get' | 'post' | 'delete', path: string, body?: object) => request.Test;

  async function actAs(userId: string): Promise<Call> {
    const created = await harness.app
      .get(SessionService)
      .create({ userId, ip: '127.0.0.1', userAgent: 'vitest' });
    const cookie = `${SessionService.COOKIE}=${created.id}; ${SessionService.CSRF_COOKIE}=${created.csrfToken}`;
    return (method, path, body) => {
      const req = harness
        .api()
        [method](`/api/v1${path}`)
        .set('Cookie', cookie)
        .set(CSRF_HEADER, created.csrfToken);
      return body === undefined ? req : req.send(body);
    };
  }

  async function world() {
    const setupToken = 'setup-' + Math.random().toString(36).slice(2);
    await harness.redis.connection.set(
      'vfm:setup:token',
      createHash('sha256').update(setupToken, 'utf8').digest('hex'),
      'EX',
      3_600,
    );
    const user = await harness
      .api()
      .post('/api/v1/auth/setup')
      .send({ token: setupToken, email: 'root@vfm.local', password: PASSWORD })
      .expect(201);
    const userId = user.body.user.id as string;
    const call = await actAs(userId);
    const org = await call('post', '/orgs', { name: 'Acme', slug: 'acme' }).expect(201);
    const orgId = org.body.id as string;
    await call('post', '/me/active-org', { orgId }).expect(204);
    return { call, userId, orgId };
  }

  /** Adds and enrols a cluster; returns credentials for its fake agent. */
  async function cluster(call: Call, orgId: string, name: string) {
    const created = await call('post', `/orgs/${orgId}/clusters`, { name }).expect(201);
    const keys = await keypair();
    const response = await enrollWith(
      makeClient(port, caPem, undefined, clients),
      created.body.bootstrapToken as string,
      keys.csrPem,
      `${FINGERPRINT}-${name}`,
    );
    const cert: AgentCert = {
      chain: Buffer.from(response.certificatePem).toString(),
      key: keys.privateKeyPem,
    };
    return { clusterId: created.body.cluster.id as string, cert, name };
  }

  async function connect(c: { cert: AgentCert; name: string }): Promise<OpenStream> {
    const stream = openStream(makeClient(port, caPem, c.cert, clients));
    stream.send(hello({ clusterFingerprint: `${FINGERPRINT}-${c.name}` }));
    expect((await stream.next()).helloAck).toBeDefined();
    return stream;
  }

  const stateOf = (id: string) =>
    harness.prisma.unscoped('test', () =>
      harness.prisma.command.findUniqueOrThrow({ where: { id } }),
    );

  async function eventually<T>(
    read: () => Promise<T>,
    ok: (v: T) => boolean,
    what: string,
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

  const refresh = (call: Call, orgId: string, clusterId: string) =>
    call('post', `/orgs/${orgId}/clusters/${clusterId}/refresh-status`);

  describe('delivery', () => {
    it('sends a command to a connected agent and walks it through ack, running and result', async () => {
      const { call, userId, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const agent = await connect(c);

      const res = await refresh(call, orgId, c.clusterId).expect(202);
      expect(['QUEUED', 'SENT']).toContain(res.body.status);
      const id = res.body.id as string;

      const received = (await agent.next()).command;
      expect(received?.commandId).toBe(id);
      expect(received?.refreshStatus).toBeDefined();
      expect(received?.requestedBy).toBe(userId);
      expect(received?.deadline && received.deadline.getTime() - Date.now()).toBeGreaterThan(
        50_000,
      );
      await eventually(
        () => stateOf(id),
        (s) => s.status === 'SENT',
        'SENT',
      );

      agent.send({
        messageId: 'a',
        ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
      });
      await eventually(
        () => stateOf(id),
        (s) => s.status === 'ACKED',
        'ACKED',
      );
      agent.send({
        messageId: 'r',
        ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_RUNNING },
      });
      await eventually(
        () => stateOf(id),
        (s) => s.status === 'RUNNING',
        'RUNNING',
      );

      agent.send({
        messageId: 'res',
        result: {
          commandId: id,
          ok: true,
          serverStatus: {
            serverVersion: 'v1.18.5',
            plugins: [{ name: 'velero.io/aws', kind: 'ObjectStore' }],
          },
        },
      });
      const done = await eventually(
        () => stateOf(id),
        (s) => s.status === 'SUCCEEDED',
        'SUCCEEDED',
      );
      expect(done.finishedAt).not.toBeNull();
      expect(done.result).toEqual({
        serverVersion: 'v1.18.5',
        plugins: [{ name: 'velero.io/aws', kind: 'ObjectStore' }],
      });

      // The command's outcome reaches the cluster record, and the API reads it back.
      const read = await call('get', `/orgs/${orgId}/clusters/${c.clusterId}`).expect(200);
      expect(read.body.veleroVersion).toBe('v1.18.5');
      const got = await call('get', `/orgs/${orgId}/clusters/${c.clusterId}/commands/${id}`).expect(
        200,
      );
      expect(got.body.status).toBe('SUCCEEDED');
      agent.cancel();
    });

    it('queues for an offline agent and delivers on connect', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');

      const res = await refresh(call, orgId, c.clusterId).expect(202);
      expect(res.body.status).toBe('QUEUED');
      expect(res.body.attempts).toBe(0);

      const agent = await connect(c);
      expect((await agent.next()).command?.commandId).toBe(res.body.id);
      const row = await eventually(
        () => stateOf(res.body.id as string),
        (s) => s.status === 'SENT',
        'SENT',
      );
      expect(row.attempts).toBe(1);
      agent.cancel();
    });

    it('re-delivers an unacknowledged command after a reconnect, with the same id', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const first = await connect(c);
      const res = await refresh(call, orgId, c.clusterId).expect(202);
      const id = res.body.id as string;
      expect((await first.next()).command?.commandId).toBe(id);

      first.cancel();
      await first.ended;
      await eventually(
        () =>
          harness.prisma.unscoped('t', () =>
            harness.prisma.cluster.findUniqueOrThrow({ where: { id: c.clusterId } }),
          ),
        (cl) => cl.status === 'DISCONNECTED',
        'DISCONNECTED',
      );

      const second = await connect(c);
      expect((await second.next()).command?.commandId).toBe(id);
      const row = await eventually(
        () => stateOf(id),
        (s) => s.attempts >= 2,
        'a second attempt',
      );
      expect(row.status).toBe('SENT');
      second.cancel();
    });

    it('does not re-deliver an acknowledged command as new work, and never a finished one', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const agent = await connect(c);
      const res = await refresh(call, orgId, c.clusterId).expect(202);
      const id = res.body.id as string;
      await agent.next();
      agent.send({ messageId: 'res', result: { commandId: id, ok: true } });
      await eventually(
        () => stateOf(id),
        (s) => s.status === 'SUCCEEDED',
        'SUCCEEDED',
      );
      agent.cancel();
      await agent.ended;

      const again = await connect(c);
      await expect(again.next(400)).rejects.toThrow(/timed out/);
      expect((await stateOf(id)).attempts).toBe(1);
      again.cancel();
    });
  });

  describe('refresh on connect', () => {
    it('asks a newly connected agent for Velero’s version, once, and records the answer', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      commands.options.refreshOnConnect = true;
      try {
        const agent = await connect(c);
        const sent = (await agent.next()).command;
        expect(sent?.refreshStatus).toBeDefined();
        // Asked by the control plane itself, not on behalf of any user.
        expect(sent?.requestedBy).toBe('');

        agent.send({
          messageId: 'r',
          result: {
            commandId: sent?.commandId ?? '',
            ok: true,
            serverStatus: {
              serverVersion: 'v1.18.4',
              plugins: [{ name: 'velero.io/aws', kind: 'ObjectStore' }],
            },
          },
        });
        await eventually(
          () => stateOf(sent?.commandId ?? ''),
          (s) => s.status === 'SUCCEEDED',
          'SUCCEEDED',
        );
        const shown = await call('get', `/orgs/${orgId}/clusters/${c.clusterId}`).expect(200);
        expect(shown.body.veleroVersion).toBe('v1.18.4');
        agent.cancel();
        await agent.ended;

        // The next connect asks again (the previous one is finished), and asks only once.
        const again = await connect(c);
        expect((await again.next()).command?.refreshStatus).toBeDefined();
        await expect(again.next(400)).rejects.toThrow(/timed out/);
        again.cancel();
      } finally {
        commands.options.refreshOnConnect = false;
      }
    });

    it('does not pile up a second refresh while one is still unfinished', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      commands.options.refreshOnConnect = true;
      try {
        const first = await connect(c);
        const sent = (await first.next()).command;
        first.cancel();
        await first.ended;

        // Reconnects before answering: the same command is re-delivered, not a new one.
        const second = await connect(c);
        expect((await second.next()).command?.commandId).toBe(sent?.commandId);
        await expect(second.next(400)).rejects.toThrow(/timed out/);
        const all = await call('get', `/orgs/${orgId}/clusters/${c.clusterId}/commands`).expect(
          200,
        );
        expect(all.body.commands).toHaveLength(1);
        second.cancel();
      } finally {
        commands.options.refreshOnConnect = false;
      }
    });
  });

  describe('what the agent may report', () => {
    it('accepts a result that arrives without its ack, and ignores a later duplicate', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const agent = await connect(c);
      const id = ((await refresh(call, orgId, c.clusterId).expect(202)).body as { id: string }).id;
      await agent.next();

      agent.send({
        messageId: '1',
        result: {
          commandId: id,
          ok: true,
          serverStatus: { serverVersion: 'v1.18.5', plugins: [] },
        },
      });
      await eventually(
        () => stateOf(id),
        (s) => s.status === 'SUCCEEDED',
        'SUCCEEDED',
      );

      // A replayed result, even a contradicting one, changes nothing.
      agent.send({
        messageId: '2',
        result: {
          commandId: id,
          ok: false,
          errorCode: ErrorCode.ERROR_CODE_INTERNAL,
          errorMessage: 'late',
          serverStatus: undefined,
        },
      });
      agent.send({
        messageId: '3',
        result: { commandId: id, ok: true, serverStatus: { serverVersion: 'v9.9.9', plugins: [] } },
      });
      await new Promise((r) => setTimeout(r, 200));
      const row = await stateOf(id);
      expect(row.status).toBe('SUCCEEDED');
      expect(row.errorCode).toBeNull();
      const cl = await call('get', `/orgs/${orgId}/clusters/${c.clusterId}`).expect(200);
      expect(cl.body.veleroVersion).toBe('v1.18.5');
      agent.cancel();
    });

    it('records a failure with its typed code, with the message stripped and bounded', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const agent = await connect(c);
      const id = ((await refresh(call, orgId, c.clusterId).expect(202)).body as { id: string }).id;
      await agent.next();

      agent.send({
        messageId: '1',
        result: {
          commandId: id,
          ok: false,
          errorCode: ErrorCode.ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY,
          errorMessage: 'denied\u001b[31m' + 'x'.repeat(5_000),
        },
      });
      const row = await eventually(
        () => stateOf(id),
        (s) => s.status === 'FAILED',
        'FAILED',
      );
      expect(row.errorCode).toBe('FORBIDDEN_BY_AGENT_POLICY');
      expect(row.errorMessage?.length).toBeLessThanOrEqual(1_000);
      // eslint-disable-next-line no-control-regex
      expect(row.errorMessage).not.toMatch(/[\u0000-\u001f]/);
      agent.cancel();
    });

    it('lets an agent report only on its own cluster’s commands', async () => {
      const { call, orgId } = await world();
      const victim = await cluster(call, orgId, 'victim');
      const attacker = await cluster(call, orgId, 'attacker');
      const victimAgent = await connect(victim);
      const attackerAgent = await connect(attacker);

      const id = ((await refresh(call, orgId, victim.clusterId).expect(202)).body as { id: string })
        .id;
      await victimAgent.next();

      // The other cluster's agent knows the id (say, from a log) and tries everything.
      attackerAgent.send({
        messageId: '1',
        ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_RUNNING },
      });
      attackerAgent.send({
        messageId: '2',
        result: { commandId: id, ok: true, serverStatus: { serverVersion: 'v666', plugins: [] } },
      });
      await new Promise((r) => setTimeout(r, 250));

      const row = await stateOf(id);
      expect(row.status).toBe('SENT');
      expect(row.result).toBeNull();
      const cl = await call('get', `/orgs/${orgId}/clusters/${victim.clusterId}`).expect(200);
      expect(cl.body.veleroVersion).not.toBe('v666');
      victimAgent.cancel();
      attackerAgent.cancel();
    });

    it('ignores a command id it has never heard of, and keeps the stream', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const agent = await connect(c);

      agent.send({
        messageId: '1',
        result: { commandId: '00000000-0000-7000-8000-000000000999', ok: true },
      });
      agent.send({
        messageId: '2',
        ack: { commandId: 'not-even-a-uuid', state: CommandAckState.COMMAND_ACK_STATE_ACKED },
      });
      // The stream is still serving: a real command still arrives.
      await refresh(call, orgId, c.clusterId).expect(202);
      expect((await agent.next()).command).toBeDefined();
      agent.cancel();
    });
  });

  describe('cancel and timeout', () => {
    it('cancels a queued command so it is never delivered', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const res = await refresh(call, orgId, c.clusterId).expect(202);
      const id = res.body.id as string;

      const cancelled = await call(
        'post',
        `/orgs/${orgId}/clusters/${c.clusterId}/commands/${id}/cancel`,
      ).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');

      const agent = await connect(c);
      await expect(agent.next(400)).rejects.toThrow(/timed out/);
      agent.cancel();
    });

    it('tells the agent to drop a command cancelled after it was sent but before it acknowledged', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const agent = await connect(c);
      const id = ((await refresh(call, orgId, c.clusterId).expect(202)).body as { id: string }).id;
      await agent.next();
      await eventually(
        () => stateOf(id),
        (s) => s.status === 'SENT',
        'SENT',
      );

      await call('post', `/orgs/${orgId}/clusters/${c.clusterId}/commands/${id}/cancel`).expect(
        200,
      );
      expect((await agent.next()).cancel?.commandId).toBe(id);
      agent.cancel();
    });

    it('refuses to cancel once the agent has taken the command, or after it finished', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const agent = await connect(c);
      const id = ((await refresh(call, orgId, c.clusterId).expect(202)).body as { id: string }).id;
      await agent.next();
      agent.send({
        messageId: 'a',
        ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
      });
      await eventually(
        () => stateOf(id),
        (s) => s.status === 'ACKED',
        'ACKED',
      );

      const refused = await call(
        'post',
        `/orgs/${orgId}/clusters/${c.clusterId}/commands/${id}/cancel`,
      ).expect(409);
      expect(refused.body.detail ?? refused.body.message).toContain('already started');
      expect((await stateOf(id)).status).toBe('ACKED');
      agent.cancel();
    });

    it('times out an overdue command, asks the agent to stop, and ignores its late result', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      const agent = await connect(c);
      const id = ((await refresh(call, orgId, c.clusterId).expect(202)).body as { id: string }).id;
      await agent.next();

      await harness.prisma.unscoped('test', () =>
        harness.prisma.command.update({
          where: { id },
          data: { deadlineAt: new Date(Date.now() - 1_000) },
        }),
      );
      await harness.redis.connection.del('vfm:commands:sweeper');
      expect(await commands.sweepTimeouts()).toBe(1);

      const row = await stateOf(id);
      expect(row.status).toBe('TIMED_OUT');
      expect(row.errorCode).toBe('TIMEOUT');
      expect((await agent.next()).cancel?.commandId).toBe(id);

      agent.send({
        messageId: 'late',
        result: { commandId: id, ok: true, serverStatus: { serverVersion: 'v-late', plugins: [] } },
      });
      await new Promise((r) => setTimeout(r, 200));
      expect((await stateOf(id)).status).toBe('TIMED_OUT');
      const cl = await call('get', `/orgs/${orgId}/clusters/${c.clusterId}`).expect(200);
      expect(cl.body.veleroVersion).not.toBe('v-late');
      agent.cancel();
    });

    it('does not time out a command that has a deadline in the future', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      await refresh(call, orgId, c.clusterId).expect(202);
      await harness.redis.connection.del('vfm:commands:sweeper');
      expect(await commands.sweepTimeouts()).toBe(0);
    });
  });

  describe('who may ask, and for what', () => {
    it('answers 404 for a cluster that is not in this org, and 409 for a disabled one', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      await call(
        'post',
        `/orgs/${orgId}/clusters/00000000-0000-7000-8000-00000000dead/refresh-status`,
      ).expect(404);

      await call('post', `/orgs/${orgId}/clusters/${c.clusterId}/disable`).expect(200);
      const res = await refresh(call, orgId, c.clusterId).expect(409);
      expect(JSON.stringify(res.body)).toContain('disabled');
    });

    it('does not let another cluster’s command id be read through this cluster’s path', async () => {
      const { call, orgId } = await world();
      const one = await cluster(call, orgId, 'one');
      const two = await cluster(call, orgId, 'two');
      const id = ((await refresh(call, orgId, one.clusterId).expect(202)).body as { id: string })
        .id;

      await call('get', `/orgs/${orgId}/clusters/${two.clusterId}/commands/${id}`).expect(404);
      await call('post', `/orgs/${orgId}/clusters/${two.clusterId}/commands/${id}/cancel`).expect(
        404,
      );
      const list = await call('get', `/orgs/${orgId}/clusters/${two.clusterId}/commands`).expect(
        200,
      );
      expect(list.body.commands).toEqual([]);
    });

    it('lets a viewer on the cluster refresh it, and shows a stranger nothing', async () => {
      const { call, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');

      await call('post', `/orgs/${orgId}/invites`, {
        email: 'dev@acme.test',
        orgRole: 'MEMBER',
      }).expect(201);
      const reg = await harness
        .api()
        .post('/api/v1/invites/register')
        .send({ token: harness.mail.tokenFor('dev@acme.test'), password: PASSWORD, name: 'dev' })
        .expect(201);
      const dev = await actAs(reg.body.user.id as string);
      await dev('post', '/me/active-org', { orgId }).expect(204);

      await refresh(dev, orgId, c.clusterId).expect(404);

      await call('post', `/clusters/${c.clusterId}/role-bindings`, {
        subjectType: 'USER',
        subjectId: reg.body.user.id,
        role: 'VIEWER',
        scope: { type: 'CLUSTER' },
      }).expect(201);
      await refresh(dev, orgId, c.clusterId).expect(202);
    });

    it('refuses to queue without bound once a cluster has too many unfinished commands', async () => {
      const { call, userId, orgId } = await world();
      const c = await cluster(call, orgId, 'prod-eu');
      await harness.prisma.unscoped('test', () =>
        harness.prisma.command.createMany({
          data: Array.from({ length: 100 }, (_, i) => ({
            id: `00000000-0000-7000-8000-${(i + 1).toString().padStart(12, '0')}`,
            orgId,
            clusterId: c.clusterId,
            requestedById: userId,
            op: 'REFRESH_STATUS',
            deadlineAt: new Date(Date.now() + 60_000),
          })),
        }),
      );
      await refresh(call, orgId, c.clusterId).expect(429);
    });
  });
});
