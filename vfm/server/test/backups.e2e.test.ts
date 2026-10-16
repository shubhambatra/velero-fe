import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommandAckState } from '../src/gateway/pb/vfm/agent/v1/command';
import { ErrorCode } from '../src/gateway/pb/vfm/agent/v1/common';
import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import { AuditService } from '../src/audit/audit.service';
import { SessionService } from '../src/auth/session.service';
import type { OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * M4 day 21: creating a backup, deleting one, and running a schedule now.
 * What is held here: the command the agent receives is exactly what was asked for;
 * a user with a namespace-scoped binding can make only the backups PLAN.md §8.2
 * allows and nothing reaches the agent when the answer is no; the escape hatch is for
 * whole-cluster administrators; a delete needs a session and sees only what the
 * caller may see; and a hidden object answers like a missing one.
 */
const K = ResourceKind;

describe('backup operations (e2e)', () => {
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

  const schedule = (name: string, template: Record<string, unknown>) =>
    resource(name, {
      kind: K.RESOURCE_KIND_SCHEDULE,
      phase: 'Enabled',
      spec: { schedule: '0 2 * * *', template },
    });

  async function setup(items = [resource('old-backup', { uid: 'uid-old' })]) {
    const { call, orgId, userId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await world.connect(agent);
    stream.send({ messageId: 's', snapshot: { snapshotId: 's1', sequence: 0, last: true, items } });
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

  /** The next command of a given arm that reaches the agent. */
  async function received<T extends 'createBackup' | 'deleteBackup' | 'triggerSchedule'>(
    stream: OpenStream,
    arm: T,
  ) {
    for (let i = 0; i < 5; i += 1) {
      const message = await stream.next();
      const command = message.command;
      if (command?.[arm] !== undefined) {
        return { id: command.commandId, requestedBy: command.requestedBy, op: command[arm] };
      }
    }
    throw new Error(`no ${arm} arrived`);
  }

  /** Whether any backup command reached the agent in this window. */
  async function silent(stream: OpenStream, ms = 400) {
    try {
      const message = await stream.next(ms);
      return message.command === undefined || message.command.refreshStatus !== undefined;
    } catch {
      return true;
    }
  }

  describe('creating a backup', () => {
    it('sends the agent exactly what was asked for and reports the command', async () => {
      const { call, userId, base, stream } = await setup();
      const res = await call('post', `${base}/backups`, {
        name: 'nightly-1',
        includedNamespaces: ['shop', 'cart'],
        excludedResources: ['events'],
        labelSelector: { matchLabels: { app: 'web' } },
        includeClusterResources: false,
        ttl: '72h',
        storageLocation: 'default',
        snapshotVolumes: false,
        defaultVolumesToFsBackup: true,
        itemOperationTimeout: '4h',
        parallelFilesUpload: 4,
      }).expect(202);
      expect(res.body).toMatchObject({
        op: 'CREATE_BACKUP',
        status: expect.stringMatching(/QUEUED|SENT/),
      });

      const { id, requestedBy, op } = await received(stream, 'createBackup');
      expect(id).toBe(res.body.id);
      expect(requestedBy).toBe(userId);
      expect(op.name).toBe('nightly-1');
      expect(op.spec).toMatchObject({
        includedNamespaces: ['shop', 'cart'],
        excludedResources: ['events'],
        includeClusterResources: false,
        ttl: { seconds: 259_200, nanos: 0 },
        storageLocation: 'default',
        snapshotVolumes: false,
        defaultVolumesToFsBackup: true,
        itemOperationTimeout: { seconds: 14_400, nanos: 0 },
        uploaderConfig: { parallelFilesUpload: 4 },
        labelSelector: { matchLabels: { app: 'web' } },
      });
      // What was not asked for is not sent.
      expect(op.spec?.snapshotMoveData).toBeUndefined();
      expect(op.advancedSpecJson.length).toBe(0);

      stream.send({
        messageId: 'a',
        ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_RUNNING },
      });
      stream.send({
        messageId: 'r',
        result: {
          commandId: id,
          ok: true,
          created: { kind: 'Backup', name: 'nightly-1', uid: 'u1' },
        },
      });
      const row = await eventually(
        () =>
          harness.prisma.unscoped('t', () =>
            harness.prisma.command.findUniqueOrThrow({ where: { id } }),
          ),
        (c) => c.status === 'SUCCEEDED',
      );
      expect(row.result).toMatchObject({ kind: 'Backup', name: 'nightly-1' });
      stream.cancel();
    });

    it('lets the agent name an unnamed backup', async () => {
      const { call, base, stream } = await setup();
      await call('post', `${base}/backups`, {
        includedNamespaces: ['shop'],
        includeClusterResources: false,
      }).expect(202);
      const { op } = await received(stream, 'createBackup');
      expect(op.name).toBe('');
      stream.cancel();
    });

    it('reports the agent’s refusal as the command’s failure', async () => {
      const { call, base, stream } = await setup();
      const res = await call('post', `${base}/backups`, { name: 'x' }).expect(202);
      const { id } = await received(stream, 'createBackup');
      stream.send({
        messageId: 'r',
        result: {
          commandId: id,
          ok: false,
          errorCode: ErrorCode.ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY,
          errorMessage: 'this agent is in read-only mode',
        },
      });
      const row = await eventually(
        () =>
          harness.prisma.unscoped('t', () =>
            harness.prisma.command.findUniqueOrThrow({ where: { id: res.body.id } }),
          ),
        (c) => c.status === 'FAILED',
      );
      expect(row).toMatchObject({
        errorCode: 'FORBIDDEN_BY_AGENT_POLICY',
        errorMessage: 'this agent is in read-only mode',
      });
      stream.cancel();
    });

    it.each([
      ['an unknown field', { nope: 1 }],
      ['a namespace glob', { includedNamespaces: ['dev*'] }],
      ['an invalid name', { name: 'Not Valid' }],
      ['a bad duration', { ttl: 'soon' }],
      ['a zero ttl', { ttl: '0s' }],
      ['hooks as a typed field', { hooks: {} }],
    ])('refuses %s with 422 and sends nothing', async (_name, body) => {
      const { call, base, stream } = await setup();
      await call('post', `${base}/backups`, body).expect(422);
      expect(await silent(stream)).toBe(true);
      expect(await commandRows()).toHaveLength(0);
      stream.cancel();
    });

    it('is audited like any mutating call, by route and field names only', async () => {
      const { call, orgId, base, stream } = await setup();
      await call('post', `${base}/backups`, {
        name: 'audited',
        includedNamespaces: ['shop'],
      }).expect(202);
      await harness.app.get(AuditService).drain();
      const res = await call('get', `/orgs/${orgId}/audit?limit=200`).expect(200);
      const events = res.body.events as { action: string; details: { fields: string[] } }[];
      const made = events.find((e) => e.action.includes('backups'));
      expect(made?.details.fields).toEqual(expect.arrayContaining(['name', 'includedNamespaces']));
      // Values are never recorded.
      expect(JSON.stringify(events)).not.toContain('audited');
      stream.cancel();
    });
  });

  describe('namespace scoping (PLAN.md §8.2)', () => {
    const scopedOperator = async (s: Awaited<ReturnType<typeof setup>>, ...ns: string[]) =>
      member(s.call, s.orgId, s.agent, 'OPERATOR', only(...ns));

    it('lets a scoped operator back up exactly their own namespaces', async () => {
      const s = await setup();
      const dev = await scopedOperator(s, 'dev', 'qa');
      await dev
        .call('post', `${s.base}/backups`, {
          includedNamespaces: ['dev', 'qa'],
          includeClusterResources: false,
        })
        .expect(202);
      const { op } = await received(s.stream, 'createBackup');
      expect(op.spec?.includedNamespaces).toEqual(['dev', 'qa']);
      s.stream.cancel();
    });

    it.each([
      ['no namespaces (everything)', { includeClusterResources: false }],
      ['the wildcard', { includedNamespaces: ['*'], includeClusterResources: false }],
      [
        'a namespace outside their scope',
        { includedNamespaces: ['dev', 'prod'], includeClusterResources: false },
      ],
      ['only an excluded list', { excludedNamespaces: ['prod'], includeClusterResources: false }],
      ['cluster resources left to Velero’s default', { includedNamespaces: ['dev'] }],
      [
        'cluster resources included',
        { includedNamespaces: ['dev'], includeClusterResources: true },
      ],
      [
        'cluster-scoped kinds named',
        {
          includedNamespaces: ['dev'],
          includeClusterResources: false,
          includedClusterScopedResources: ['persistentvolumes'],
        },
      ],
    ])(
      'refuses a scoped operator asking for %s, and the agent hears nothing',
      async (_name, body) => {
        const s = await setup();
        const dev = await scopedOperator(s, 'dev');
        await dev.call('post', `${s.base}/backups`, body).expect(403);
        expect(await silent(s.stream)).toBe(true);
        expect(await commandRows()).toHaveLength(0);
        s.stream.cancel();
      },
    );

    it('lets a whole-cluster operator back up everything, cluster resources included', async () => {
      const s = await setup();
      const ops = await member(s.call, s.orgId, s.agent, 'OPERATOR', whole);
      await ops.call('post', `${s.base}/backups`, {}).expect(202);
      await ops
        .call('post', `${s.base}/backups`, {
          includedNamespaces: ['*'],
          includeClusterResources: true,
        })
        .expect(202);
      s.stream.cancel();
    });

    it('does not let a viewer back anything up', async () => {
      const s = await setup();
      const viewer = await member(s.call, s.orgId, s.agent, 'VIEWER', whole);
      await viewer
        .call('post', `${s.base}/backups`, {
          includedNamespaces: ['dev'],
          includeClusterResources: false,
        })
        .expect(403);
      s.stream.cancel();
    });

    it('does not reveal the cluster to someone with no access to it', async () => {
      const s = await setup();
      const stranger = await world.member(s.call, s.orgId, 'stranger@acme.test');
      await stranger.call('post', `${s.base}/backups`, {}).expect(404);
      s.stream.cancel();
    });
  });

  describe('the advanced escape hatch', () => {
    const advanced = {
      advancedSpec: {
        hooks: { resources: [{ name: 'h', pre: [{ exec: { command: ['/bin/sync'] } }] }] },
      },
    };

    it('is for whole-cluster administrators only', async () => {
      const s = await setup();
      const operator = await member(s.call, s.orgId, s.agent, 'OPERATOR', whole);
      const scopedAdmin = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', only('dev'));
      const admin = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', whole);

      const body = { includedNamespaces: ['dev'], includeClusterResources: false, ...advanced };
      await operator.call('post', `${s.base}/backups`, body).expect(403);
      await scopedAdmin.call('post', `${s.base}/backups`, body).expect(403);
      expect(await silent(s.stream)).toBe(true);

      await admin.call('post', `${s.base}/backups`, body).expect(202);
      const { op } = await received(s.stream, 'createBackup');
      expect(JSON.parse(Buffer.from(op.advancedSpecJson).toString())).toEqual(
        advanced.advancedSpec,
      );
      s.stream.cancel();
    });

    it('refuses an oversized document', async () => {
      const s = await setup();
      await s
        .call('post', `${s.base}/backups`, { advancedSpec: { big: 'x'.repeat(300_000) } })
        .expect(422);
      s.stream.cancel();
    });
  });

  describe('API tokens', () => {
    it('apply their narrowed permissions', async () => {
      const s = await setup();
      const make = async (permissions: string[]) =>
        (
          (
            await s
              .call('post', `/orgs/${s.orgId}/tokens`, {
                name: `t-${permissions.length.toString()}`,
                permissions,
              })
              .expect(201)
          ).body as { token: string }
        ).token;
      const post = (token: string) =>
        harness
          .api()
          .post(`/api/v1${s.base}/backups`)
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'via-token' });

      await post(await make(['cluster:read', 'backup:read'])).expect(403);
      await post(await make(['cluster:read', 'backup:create'])).expect(202);
      s.stream.cancel();
    });

    it('cannot delete: that needs a person at a browser', async () => {
      const s = await setup();
      const token = (
        (await s.call('post', `/orgs/${s.orgId}/tokens`, { name: 'd' }).expect(201)).body as {
          token: string;
        }
      ).token;
      await harness
        .api()
        .delete(`/api/v1${s.base}/backups/old-backup`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      s.stream.cancel();
    });
  });

  describe('deleting a backup', () => {
    it('asks the agent to delete the visible backup, and only that one', async () => {
      const s = await setup();
      const res = await s.call('delete', `${s.base}/backups/old-backup`).expect(202);
      expect(res.body.op).toBe('DELETE_BACKUP');
      const { op } = await received(s.stream, 'deleteBackup');
      expect(op.name).toBe('old-backup');
      s.stream.cancel();
    });

    it('needs a recently re-authenticated session', async () => {
      const s = await setup();
      const actor = await world.actAs(s.userId);
      await harness.app
        .get(SessionService)
        .update((actor as unknown as { sessionId: string }).sessionId, {
          lastReauthAt: Date.now() - 10 * 60 * 1_000,
        });
      const res = await actor('delete', `${s.base}/backups/old-backup`).expect(403);
      expect(res.body.sudoRequired).toBe(true);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('is for cluster administrators', async () => {
      const s = await setup();
      const operator = await member(s.call, s.orgId, s.agent, 'OPERATOR', whole);
      await operator.call('delete', `${s.base}/backups/old-backup`).expect(403);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('lets a scoped administrator delete only backups inside their scope, and answers 404 for the rest', async () => {
      const s = await setup([
        resource('dev-backup', {
          uid: 'u-d',
          spec: { includedNamespaces: ['dev'], includeClusterResources: false },
        }),
        resource('prod-backup', {
          uid: 'u-p',
          spec: { includedNamespaces: ['prod'], includeClusterResources: false },
        }),
        resource('everything', { uid: 'u-e', spec: {} }),
      ]);
      const dev = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', only('dev'));

      const hidden = await dev.call('delete', `${s.base}/backups/prod-backup`).expect(404);
      const wide = await dev.call('delete', `${s.base}/backups/everything`).expect(404);
      const missing = await dev.call('delete', `${s.base}/backups/nope`).expect(404);
      expect(hidden.body.detail).toBe(missing.body.detail);
      expect(wide.body.detail).toBe(missing.body.detail);
      expect(await silent(s.stream)).toBe(true);

      await dev.call('delete', `${s.base}/backups/dev-backup`).expect(202);
      expect((await received(s.stream, 'deleteBackup')).op.name).toBe('dev-backup');
      s.stream.cancel();
    });

    it('does not delete a backup that is already being deleted, or one that does not exist', async () => {
      const s = await setup([resource('going', { uid: 'u', phase: 'Deleting' })]);
      await s.call('delete', `${s.base}/backups/going`).expect(409);
      await s.call('delete', `${s.base}/backups/nope`).expect(404);
      await s.call('delete', `${s.base}/backups/Bad..Name`).expect(422);
      s.stream.cancel();
    });
  });

  describe('running a schedule now', () => {
    const items = () => [
      schedule('nightly', { includedNamespaces: ['dev'], includeClusterResources: false }),
      schedule('everything', {}),
      schedule('prod-only', { includedNamespaces: ['prod'], includeClusterResources: false }),
    ];

    it('asks the agent to run it, under a name if one is given', async () => {
      const s = await setup(items());
      const res = await s
        .call('post', `${s.base}/schedules/nightly/trigger`, { backupName: 'manual-1' })
        .expect(202);
      expect(res.body.op).toBe('TRIGGER_SCHEDULE');
      const { op } = await received(s.stream, 'triggerSchedule');
      expect(op).toMatchObject({ scheduleName: 'nightly', backupName: 'manual-1' });

      await s.call('post', `${s.base}/schedules/nightly/trigger`).expect(202);
      expect((await received(s.stream, 'triggerSchedule')).op.backupName).toBe('');
      s.stream.cancel();
    });

    it('holds a scoped operator to what the schedule would back up', async () => {
      const s = await setup(items());
      const dev = await member(s.call, s.orgId, s.agent, 'OPERATOR', only('dev'));

      await dev.call('post', `${s.base}/schedules/nightly/trigger`).expect(202);
      // A template with no namespaces and Velero's default for cluster resources reaches everything.
      await dev.call('post', `${s.base}/schedules/everything/trigger`).expect(404);
      // A schedule over another namespace is not theirs to see.
      const hidden = await dev.call('post', `${s.base}/schedules/prod-only/trigger`).expect(404);
      const missing = await dev.call('post', `${s.base}/schedules/nope/trigger`).expect(404);
      expect(hidden.body.detail).toBe(missing.body.detail);
      s.stream.cancel();
    });

    it('refuses with 403 a schedule a scoped operator can read but whose template reaches beyond their scope', async () => {
      const s = await setup([
        ...items(),
        schedule('dev-auto-cluster', { includedNamespaces: ['dev'] }),
      ]);
      // Reads everything (a whole-cluster viewer binding), may back up only dev.
      const user = await member(s.call, s.orgId, s.agent, 'VIEWER', whole);
      await s
        .call('post', `/clusters/${s.agent.clusterId}/role-bindings`, {
          subjectType: 'USER',
          subjectId: user.userId,
          role: 'OPERATOR',
          scope: only('dev'),
        })
        .expect(201);

      await user.call('post', `${s.base}/schedules/everything/trigger`).expect(403);
      await user.call('post', `${s.base}/schedules/prod-only/trigger`).expect(403);
      await user.call('post', `${s.base}/schedules/dev-auto-cluster/trigger`).expect(403);
      expect(await silent(s.stream)).toBe(true);
      await user.call('post', `${s.base}/schedules/nightly/trigger`).expect(202);
      s.stream.cancel();
    });

    it('refuses with 403 a schedule the caller can see but may not run', async () => {
      const s = await setup([schedule('auto-cluster', { includedNamespaces: ['dev'] })]);
      // A whole-cluster viewer sees it; an operator scoped to dev would see it only if it covered dev alone.
      const viewer = await member(s.call, s.orgId, s.agent, 'VIEWER', whole);
      await viewer.call('post', `${s.base}/schedules/auto-cluster/trigger`).expect(403);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('refuses unknown body fields and a bad name', async () => {
      const s = await setup(items());
      await s.call('post', `${s.base}/schedules/nightly/trigger`, { nope: 1 }).expect(422);
      await s
        .call('post', `${s.base}/schedules/nightly/trigger`, { backupName: 'Bad Name' })
        .expect(422);
      s.stream.cancel();
    });
  });

  describe('what the caller may do (the UI’s hint)', () => {
    const accessOf = async (call: Call, base: string) =>
      (await call('get', `${base}/access`).expect(200)).body.access as Record<string, string>;

    it('says cluster, scoped or none for each permission', async () => {
      const s = await setup();
      const viewer = await member(s.call, s.orgId, s.agent, 'VIEWER', whole);
      const scoped = await member(s.call, s.orgId, s.agent, 'OPERATOR', only('dev'));
      const scopedAdmin = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', only('dev'));
      const stranger = await world.member(s.call, s.orgId, 'nobody@acme.test');

      const owner = await accessOf(s.call, s.base);
      expect(Object.values(owner).every((v) => v === 'cluster')).toBe(true);

      expect(await accessOf(viewer.call, s.base)).toMatchObject({
        'backup:create': 'none',
        'backup:delete': 'none',
        'advanced:write': 'none',
      });
      expect(await accessOf(scoped.call, s.base)).toMatchObject({
        'backup:create': 'scoped',
        'backup:logs': 'scoped',
        'backup:delete': 'none',
        'restore:create': 'none',
        'advanced:write': 'none',
      });
      // A cluster-level permission is not held "for some namespaces".
      expect(await accessOf(scopedAdmin.call, s.base)).toMatchObject({
        'backup:delete': 'scoped',
        'storage:write': 'none',
        'advanced:write': 'none',
      });
      await stranger.call('get', `${s.base}/access`).expect(404);
      s.stream.cancel();
    });
  });

  it('does not reach another organization’s cluster', async () => {
    const s = await setup();
    const other = await s.call('post', '/orgs', { name: 'Other', slug: 'other' }).expect(201);
    const clusterId = s.base.split('/')[4] ?? '';
    await s
      .call('post', `/orgs/${other.body.id as string}/clusters/${clusterId}/backups`, {})
      .expect(404);
    await s
      .call('delete', `/orgs/${other.body.id as string}/clusters/${clusterId}/backups/old-backup`)
      .expect(404);
    s.stream.cancel();
  });
});
