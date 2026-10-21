import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SessionService } from '../src/auth/session.service';
import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import type { OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * M4 day 25: creating, changing, pausing and deleting schedules. A schedule runs later,
 * as Velero, so writing one is authorized over everything its template covers; changing
 * one also needs the template it has now; deleting needs a recent sign-in; nothing
 * reaches the agent when the answer is no.
 */
const K = ResourceKind;

describe('schedule operations (e2e)', () => {
  let harness: TestApp;
  let world: World;

  beforeAll(async () => {
    harness = await createTestApp({ gateway: true });
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

  async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const value = await read();
      if (ok(value)) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out');
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const commandRows = () =>
    harness.prisma.unscoped('t', () =>
      harness.prisma.command.findMany({ where: { op: { not: 'REFRESH_STATUS' } } }),
    );

  const schedule = (name: string, uid: string, template: object) =>
    resource(name, {
      kind: K.RESOURCE_KIND_SCHEDULE,
      uid,
      spec: { schedule: '0 2 * * *', template },
    });

  const items = () => [
    schedule('dev-nightly', 'u1', { includedNamespaces: ['dev'], includeClusterResources: false }),
    schedule('prod-nightly', 'u2', {
      includedNamespaces: ['prod'],
      includeClusterResources: false,
    }),
    schedule('everything', 'u3', {}),
  ];

  async function setup(inventory = items()) {
    const { call, orgId, userId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await world.connect(agent);
    stream.send({
      messageId: 's',
      snapshot: { snapshotId: 's1', sequence: 0, last: true, items: inventory },
    });
    await eventually(
      () =>
        harness.prisma.unscoped('t', () =>
          harness.prisma.cluster.findUniqueOrThrow({ where: { id: agent.clusterId } }),
        ),
      (c) => c.inventorySnapshotId === 's1',
    );
    return {
      call,
      orgId,
      userId,
      agent,
      stream,
      base: `/orgs/${orgId}/clusters/${agent.clusterId}`,
    };
  }

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

  const whole = { type: 'CLUSTER' };
  const only = (...namespaces: string[]) => ({ type: 'NAMESPACES', namespaces });

  type Arm = 'createSchedule' | 'updateSchedule' | 'setSchedulePaused' | 'deleteSchedule';
  async function received<T extends Arm>(stream: OpenStream, arm: T) {
    for (let i = 0; i < 5; i += 1) {
      const command = (await stream.next()).command;
      if (command?.[arm] !== undefined) {
        return { id: command.commandId, requestedBy: command.requestedBy, op: command[arm] };
      }
    }
    throw new Error(`no ${arm} arrived`);
  }

  async function silent(stream: OpenStream, ms = 400) {
    try {
      const message = await stream.next(ms);
      return message.command === undefined || message.command.refreshStatus !== undefined;
    } catch {
      return true;
    }
  }

  const body = (extra: object = {}) => ({
    name: 'nightly',
    schedule: '0 2 * * *',
    template: { includedNamespaces: ['dev'], includeClusterResources: false, ttl: '720h' },
    ...extra,
  });

  describe('creating a schedule', () => {
    it('sends the agent exactly what was asked for', async () => {
      const { call, userId, base, stream } = await setup();
      const res = await call('post', `${base}/schedules`, body({ paused: true })).expect(202);
      expect(res.body).toMatchObject({ op: 'CREATE_SCHEDULE' });

      const { id, requestedBy, op } = await received(stream, 'createSchedule');
      expect(id).toBe(res.body.id);
      expect(requestedBy).toBe(userId);
      expect(op.name).toBe('nightly');
      expect(op.spec).toMatchObject({
        schedule: '0 2 * * *',
        paused: true,
        template: {
          includedNamespaces: ['dev'],
          includeClusterResources: false,
          ttl: { seconds: 2_592_000, nanos: 0 },
        },
      });
      stream.cancel();
    });

    it.each([
      ['an unreadable cron', { schedule: 'every day' }],
      ['a cron with a seconds field', { schedule: '0 0 2 * * *' }],
      ['a name too long for its backups', { name: 'a'.repeat(49) }],
      ['an unknown field', { nope: 1 }],
      ['an unknown template field', { template: { nope: 1 } }],
      ['a zero ttl', { template: { ttl: '0s' } }],
      ['no template', { template: undefined }],
    ])('refuses %s with 422 and sends nothing', async (_name, extra) => {
      const { call, base, stream } = await setup();
      await call('post', `${base}/schedules`, body(extra)).expect(422);
      expect(await silent(stream)).toBe(true);
      expect(await commandRows()).toHaveLength(0);
      stream.cancel();
    });

    it('is open to a token and to a session that has not signed in recently', async () => {
      const s = await setup();
      const actor = await world.actAs(s.userId);
      await harness.app
        .get(SessionService)
        .update((actor as unknown as { sessionId: string }).sessionId, {
          lastReauthAt: Date.now() - 10 * 60 * 1_000,
        });
      await actor('post', `${s.base}/schedules`, body()).expect(202);
      s.stream.cancel();
    });
  });

  describe('who may write a schedule', () => {
    const scopedOperator = (s: Awaited<ReturnType<typeof setup>>, ...ns: string[]) =>
      member(s.call, s.orgId, s.agent, 'OPERATOR', only(...ns));

    it('lets a namespace-limited operator schedule their own namespaces', async () => {
      const s = await setup();
      const dev = await scopedOperator(s, 'dev');
      await dev.call('post', `${s.base}/schedules`, body()).expect(202);
      s.stream.cancel();
    });

    it.each([
      [
        'another namespace',
        { template: { includedNamespaces: ['prod'], includeClusterResources: false } },
      ],
      ['every namespace', { template: { includeClusterResources: false } }],
      ['a wildcard', { template: { includedNamespaces: ['*'], includeClusterResources: false } }],
      ['cluster resources left on', { template: { includedNamespaces: ['dev'] } }],
      [
        'a cluster-scoped kind',
        {
          template: {
            includedNamespaces: ['dev'],
            includeClusterResources: false,
            includedClusterScopedResources: ['persistentvolumes'],
          },
        },
      ],
    ])(
      'refuses a scoped operator asking for %s, and the agent hears nothing',
      async (_n, extra) => {
        const s = await setup();
        const dev = await scopedOperator(s, 'dev');
        await dev.call('post', `${s.base}/schedules`, body(extra)).expect(403);
        expect(await silent(s.stream)).toBe(true);
        expect(await commandRows()).toHaveLength(0);
        s.stream.cancel();
      },
    );

    it('does not let a viewer or a restorer write one', async () => {
      const s = await setup();
      for (const role of ['VIEWER', 'RESTORER']) {
        const user = await member(s.call, s.orgId, s.agent, role, whole);
        await user.call('post', `${s.base}/schedules`, body()).expect(403);
      }
      s.stream.cancel();
    });

    it('keeps the escape hatch for whole-cluster administrators', async () => {
      const s = await setup();
      const operator = await member(s.call, s.orgId, s.agent, 'OPERATOR', whole);
      const admin = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', whole);
      const advanced = { advancedSpec: { hooks: { resources: [{ name: 'h' }] } } };
      await operator.call('post', `${s.base}/schedules`, body(advanced)).expect(403);
      expect(await silent(s.stream)).toBe(true);
      await admin.call('post', `${s.base}/schedules`, body(advanced)).expect(202);
      const { op } = await received(s.stream, 'createSchedule');
      expect(JSON.parse(Buffer.from(op.advancedSpecJson).toString())).toEqual(
        advanced.advancedSpec,
      );
      s.stream.cancel();
    });
  });

  describe('changing a schedule', () => {
    const change = {
      schedule: '0 4 * * 1',
      template: { includedNamespaces: ['dev'], includeClusterResources: false },
    };

    it('replaces the spec of a visible schedule', async () => {
      const s = await setup();
      const res = await s.call('put', `${s.base}/schedules/dev-nightly`, change).expect(202);
      expect(res.body.op).toBe('UPDATE_SCHEDULE');
      const { op } = await received(s.stream, 'updateSchedule');
      expect(op.name).toBe('dev-nightly');
      expect(op.spec).toMatchObject({ schedule: '0 4 * * 1', paused: false });
      s.stream.cancel();
    });

    it('answers 404 for a schedule that does not exist, and 422 for a bad body', async () => {
      const s = await setup();
      await s.call('put', `${s.base}/schedules/ghost`, change).expect(404);
      await s
        .call('put', `${s.base}/schedules/dev-nightly`, { ...change, schedule: 'x' })
        .expect(422);
      await s
        .call('put', `${s.base}/schedules/dev-nightly`, { ...change, name: 'other' })
        .expect(422);
      expect(await commandRows()).toHaveLength(0);
      s.stream.cancel();
    });

    it('does not let a scoped operator touch a schedule outside their namespaces', async () => {
      const s = await setup();
      const dev = await member(s.call, s.orgId, s.agent, 'OPERATOR', only('dev'));
      // Hidden and missing look the same.
      await dev.call('put', `${s.base}/schedules/prod-nightly`, change).expect(404);
      await dev.call('put', `${s.base}/schedules/everything`, change).expect(404);
      // Their own, but rewritten to reach beyond.
      await dev
        .call('put', `${s.base}/schedules/dev-nightly`, {
          ...change,
          template: { includedNamespaces: ['dev', 'prod'], includeClusterResources: false },
        })
        .expect(403);
      expect(await silent(s.stream)).toBe(true);
      await dev.call('put', `${s.base}/schedules/dev-nightly`, change).expect(202);
      s.stream.cancel();
    });

    it('needs the schedule’s current template in reach, not only the new one', async () => {
      // Visible to a user limited to `dev`, but it also backs up cluster-scoped resources,
      // which that user could not have asked for. Narrowing it must not be a way in.
      const s = await setup([schedule('wide', 'u9', { includedNamespaces: ['dev'] })]);
      const dev = await member(s.call, s.orgId, s.agent, 'OPERATOR', only('dev'));
      await dev.call('put', `${s.base}/schedules/wide`, change).expect(403);
      expect(await silent(s.stream)).toBe(true);
      const admin = await member(s.call, s.orgId, s.agent, 'OPERATOR', whole);
      await admin.call('put', `${s.base}/schedules/wide`, change).expect(202);
      s.stream.cancel();
    });
  });

  describe('pausing and resuming', () => {
    it('sends the new state', async () => {
      const s = await setup();
      for (const paused of [true, false]) {
        const res = await s
          .call('post', `${s.base}/schedules/dev-nightly/pause`, { paused })
          .expect(202);
        expect(res.body.op).toBe('SET_SCHEDULE_PAUSED');
        expect((await received(s.stream, 'setSchedulePaused')).op).toEqual({
          name: 'dev-nightly',
          paused,
        });
      }
      s.stream.cancel();
    });

    it('refuses a body that is not a boolean, and a schedule out of reach', async () => {
      const s = await setup();
      await s.call('post', `${s.base}/schedules/dev-nightly/pause`, { paused: 'yes' }).expect(422);
      await s.call('post', `${s.base}/schedules/dev-nightly/pause`, {}).expect(422);
      const dev = await member(s.call, s.orgId, s.agent, 'OPERATOR', only('dev'));
      await dev
        .call('post', `${s.base}/schedules/prod-nightly/pause`, { paused: true })
        .expect(404);
      const viewer = await member(s.call, s.orgId, s.agent, 'VIEWER', whole);
      await viewer
        .call('post', `${s.base}/schedules/dev-nightly/pause`, { paused: true })
        .expect(403);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });
  });

  describe('deleting a schedule', () => {
    it('asks the agent to delete the visible schedule', async () => {
      const s = await setup();
      const res = await s.call('delete', `${s.base}/schedules/dev-nightly`).expect(202);
      expect(res.body.op).toBe('DELETE_SCHEDULE');
      expect((await received(s.stream, 'deleteSchedule')).op.name).toBe('dev-nightly');
      s.stream.cancel();
    });

    it('needs a recent sign-in and is not open to a token', async () => {
      const s = await setup();
      const token = (
        (await s.call('post', `/orgs/${s.orgId}/tokens`, { name: 't' }).expect(201)).body as {
          token: string;
        }
      ).token;
      await harness
        .api()
        .delete(`/api/v1${s.base}/schedules/dev-nightly`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      const actor = await world.actAs(s.userId);
      await harness.app
        .get(SessionService)
        .update((actor as unknown as { sessionId: string }).sessionId, {
          lastReauthAt: Date.now() - 10 * 60 * 1_000,
        });
      expect(
        (await actor('delete', `${s.base}/schedules/dev-nightly`).expect(403)).body.sudoRequired,
      ).toBe(true);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('is for administrators, and only for schedules in their scope', async () => {
      const s = await setup();
      const operator = await member(s.call, s.orgId, s.agent, 'OPERATOR', whole);
      await operator.call('delete', `${s.base}/schedules/dev-nightly`).expect(403);

      const scoped = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', only('dev'));
      await scoped.call('delete', `${s.base}/schedules/prod-nightly`).expect(404);
      await scoped.call('delete', `${s.base}/schedules/everything`).expect(404);
      expect(await silent(s.stream)).toBe(true);
      await scoped.call('delete', `${s.base}/schedules/dev-nightly`).expect(202);
      s.stream.cancel();
    });

    it('answers 404 for a missing schedule', async () => {
      const s = await setup();
      await s.call('delete', `${s.base}/schedules/ghost`).expect(404);
      s.stream.cancel();
    });
  });
});
