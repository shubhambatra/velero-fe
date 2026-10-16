import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SessionService } from '../src/auth/session.service';
import { ErrorCode } from '../src/gateway/pb/vfm/agent/v1/common';
import { ExistingResourcePolicy } from '../src/gateway/pb/vfm/agent/v1/velero';
import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import type { OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * M4 day 23: creating and deleting restores. What is held here: the command the agent
 * receives is exactly what was asked for; a restore is authorized over every namespace it
 * reads *and* writes (after mapping), so a namespace-scoped user can neither write into
 * nor read from outside their scope; a restore needs a session that signed in recently
 * and is not open to API tokens; the escape hatch is for whole-cluster administrators; and
 * nothing reaches the agent when the answer is no.
 */
const K = ResourceKind;

describe('restore operations (e2e)', () => {
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

  async function setup(
    items = [
      resource('nightly-1', {
        uid: 'u-b',
        spec: { includedNamespaces: ['dev'], includeClusterResources: false },
      }),
    ],
  ) {
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

  async function received<T extends 'createRestore' | 'deleteRestore'>(stream: OpenStream, arm: T) {
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

  describe('creating a restore', () => {
    it('sends the agent exactly what was asked for', async () => {
      const { call, userId, base, stream } = await setup();
      const res = await call('post', `${base}/restores`, {
        name: 'r1',
        backupName: 'nightly-1',
        includedNamespaces: ['shop'],
        excludedResources: ['events'],
        namespaceMapping: { shop: 'shop-restored' },
        includeClusterResources: false,
        restorePVs: false,
        existingResourcePolicy: 'update',
        itemOperationTimeout: '2h',
        resourceModifier: 'mods',
        parallelFilesDownload: 3,
      }).expect(202);
      expect(res.body).toMatchObject({ op: 'CREATE_RESTORE' });

      const { id, requestedBy, op } = await received(stream, 'createRestore');
      expect(id).toBe(res.body.id);
      expect(requestedBy).toBe(userId);
      expect(op.name).toBe('r1');
      expect(op.spec).toMatchObject({
        backupName: 'nightly-1',
        scheduleName: '',
        includedNamespaces: ['shop'],
        excludedResources: ['events'],
        namespaceMapping: { shop: 'shop-restored' },
        includeClusterResources: false,
        restorePvs: false,
        existingResourcePolicy: ExistingResourcePolicy.EXISTING_RESOURCE_POLICY_UPDATE,
        itemOperationTimeout: { seconds: 7200, nanos: 0 },
        resourceModifier: { kind: 'ConfigMap', name: 'mods' },
        uploaderConfig: { parallelFilesDownload: 3 },
      });
      expect(op.spec?.preserveNodePorts).toBeUndefined();
      expect(op.advancedSpecJson.length).toBe(0);
      stream.cancel();
    });

    it('restores from a schedule', async () => {
      const { call, base, stream } = await setup();
      await call('post', `${base}/restores`, {
        scheduleName: 'nightly',
        includedNamespaces: ['dev'],
        includeClusterResources: false,
      }).expect(202);
      const { op } = await received(stream, 'createRestore');
      expect(op.spec).toMatchObject({ scheduleName: 'nightly', backupName: '' });
      stream.cancel();
    });

    it.each([
      ['no source', { includedNamespaces: ['dev'] }],
      ['two sources', { backupName: 'b', scheduleName: 's' }],
      ['an unknown field', { backupName: 'b', nope: 1 }],
      ['a mapping to a glob', { backupName: 'b', namespaceMapping: { a: 'b*' } }],
      ['hooks as a typed field', { backupName: 'b', hooks: {} }],
      ['an unknown policy', { backupName: 'b', existingResourcePolicy: 'merge' }],
      ['a zero timeout', { backupName: 'b', itemOperationTimeout: '0s' }],
    ])('refuses %s with 422 and sends nothing', async (_name, body) => {
      const { call, base, stream } = await setup();
      await call('post', `${base}/restores`, body).expect(422);
      expect(await silent(stream)).toBe(true);
      expect(await commandRows()).toHaveLength(0);
      stream.cancel();
    });

    it('needs a recently re-authenticated session', async () => {
      const s = await setup();
      const actor = await world.actAs(s.userId);
      await harness.app
        .get(SessionService)
        .update((actor as unknown as { sessionId: string }).sessionId, {
          lastReauthAt: Date.now() - 10 * 60 * 1_000,
        });
      const res = await actor('post', `${s.base}/restores`, { backupName: 'nightly-1' }).expect(
        403,
      );
      expect(res.body.sudoRequired).toBe(true);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('is not open to an API token', async () => {
      const s = await setup();
      const token = (
        (await s.call('post', `/orgs/${s.orgId}/tokens`, { name: 't' }).expect(201)).body as {
          token: string;
        }
      ).token;
      await harness
        .api()
        .post(`/api/v1${s.base}/restores`)
        .set('Authorization', `Bearer ${token}`)
        .send({ backupName: 'nightly-1' })
        .expect(403);
      expect(await commandRows()).toHaveLength(0);
      s.stream.cancel();
    });

    it('reports the agent’s refusal as the command’s failure', async () => {
      const { call, base, stream } = await setup();
      const res = await call('post', `${base}/restores`, { backupName: 'nightly-1' }).expect(202);
      const { id } = await received(stream, 'createRestore');
      stream.send({
        messageId: 'r',
        result: {
          commandId: id,
          ok: false,
          errorCode: ErrorCode.ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY,
          errorMessage: 'restoring into namespace "velero" is not permitted on this cluster',
        },
      });
      const row = await eventually(
        () =>
          harness.prisma.unscoped('t', () =>
            harness.prisma.command.findUniqueOrThrow({ where: { id: res.body.id } }),
          ),
        (c) => c.status === 'FAILED',
      );
      expect(row).toMatchObject({ errorCode: 'FORBIDDEN_BY_AGENT_POLICY' });
      stream.cancel();
    });
  });

  describe('namespace scoping covers what is read and what is written', () => {
    const restorer = (s: Awaited<ReturnType<typeof setup>>, ...ns: string[]) =>
      member(s.call, s.orgId, s.agent, 'RESTORER', only(...ns));

    it('lets a scoped restorer restore within their namespaces', async () => {
      const s = await setup();
      const dev = await restorer(s, 'dev', 'qa');
      await dev
        .call('post', `${s.base}/restores`, {
          backupName: 'nightly-1',
          includedNamespaces: ['dev'],
          namespaceMapping: { dev: 'qa' },
          includeClusterResources: false,
        })
        .expect(202);
      const { op } = await received(s.stream, 'createRestore');
      expect(op.spec?.namespaceMapping).toEqual({ dev: 'qa' });
      s.stream.cancel();
    });

    it.each([
      [
        'writing into a namespace outside their scope',
        { includedNamespaces: ['dev'], namespaceMapping: { dev: 'prod' } },
      ],
      [
        'reading from a namespace outside their scope into their own',
        { includedNamespaces: ['prod'], namespaceMapping: { prod: 'dev' } },
      ],
      ['a namespace outside their scope', { includedNamespaces: ['dev', 'prod'] }],
      ['no namespaces (everything)', {}],
      ['the wildcard', { includedNamespaces: ['*'] }],
      ['everything, with a mapping that looks harmless', { namespaceMapping: { dev: 'qa' } }],
      [
        'cluster resources left to Velero’s default',
        { includedNamespaces: ['dev'], includeClusterResources: undefined },
      ],
      [
        'cluster resources included',
        { includedNamespaces: ['dev'], includeClusterResources: true },
      ],
    ])('refuses a scoped restorer %s, and the agent hears nothing', async (_name, over) => {
      const s = await setup();
      const dev = await restorer(s, 'dev', 'qa');
      const body = { backupName: 'nightly-1', includeClusterResources: false, ...over };
      await dev.call('post', `${s.base}/restores`, body).expect(403);
      expect(await silent(s.stream)).toBe(true);
      expect(await commandRows()).toHaveLength(0);
      s.stream.cancel();
    });

    it('lets a whole-cluster restorer restore anywhere', async () => {
      const s = await setup();
      const all = await member(s.call, s.orgId, s.agent, 'RESTORER', whole);
      await all.call('post', `${s.base}/restores`, { backupName: 'nightly-1' }).expect(202);
      await all
        .call('post', `${s.base}/restores`, {
          backupName: 'nightly-1',
          includedNamespaces: ['prod'],
          namespaceMapping: { prod: 'dev' },
        })
        .expect(202);
      s.stream.cancel();
    });

    it('does not let an operator or a viewer restore', async () => {
      const s = await setup();
      const body = {
        backupName: 'nightly-1',
        includedNamespaces: ['dev'],
        includeClusterResources: false,
      };
      const operator = await member(s.call, s.orgId, s.agent, 'OPERATOR', whole);
      const viewer = await member(s.call, s.orgId, s.agent, 'VIEWER', whole);
      await operator.call('post', `${s.base}/restores`, body).expect(403);
      await viewer.call('post', `${s.base}/restores`, body).expect(403);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('does not reveal the cluster to someone with no access to it', async () => {
      const s = await setup();
      const stranger = await world.member(s.call, s.orgId, 'stranger@acme.test');
      await stranger.call('post', `${s.base}/restores`, { backupName: 'nightly-1' }).expect(404);
      s.stream.cancel();
    });
  });

  describe('the advanced escape hatch', () => {
    const advanced = {
      advancedSpec: {
        hooks: { resources: [{ name: 'h', postHooks: [{ exec: { command: ['/bin/fix'] } }] }] },
      },
    };

    it('is for whole-cluster administrators only', async () => {
      const s = await setup();
      const restorer = await member(s.call, s.orgId, s.agent, 'RESTORER', whole);
      const scopedAdmin = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', only('dev'));
      const admin = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', whole);
      const body = {
        backupName: 'nightly-1',
        includedNamespaces: ['dev'],
        includeClusterResources: false,
        ...advanced,
      };

      await restorer.call('post', `${s.base}/restores`, body).expect(403);
      await scopedAdmin.call('post', `${s.base}/restores`, body).expect(403);
      expect(await silent(s.stream)).toBe(true);

      await admin.call('post', `${s.base}/restores`, body).expect(202);
      const { op } = await received(s.stream, 'createRestore');
      expect(JSON.parse(Buffer.from(op.advancedSpecJson).toString())).toEqual(
        advanced.advancedSpec,
      );
      s.stream.cancel();
    });
  });

  describe('deleting a restore', () => {
    const items = () => [
      resource('r-dev', {
        kind: K.RESOURCE_KIND_RESTORE,
        uid: 'u1',
        spec: { backupName: 'b', includedNamespaces: ['dev'], includeClusterResources: false },
      }),
      resource('r-from-prod', {
        kind: K.RESOURCE_KIND_RESTORE,
        uid: 'u2',
        spec: {
          backupName: 'b',
          includedNamespaces: ['prod'],
          namespaceMapping: { prod: 'dev' },
          includeClusterResources: false,
        },
      }),
      resource('r-all', { kind: K.RESOURCE_KIND_RESTORE, uid: 'u3', spec: { backupName: 'b' } }),
    ];

    it('asks the agent to delete the visible restore', async () => {
      const s = await setup(items());
      const res = await s.call('delete', `${s.base}/restores/r-dev`).expect(202);
      expect(res.body.op).toBe('DELETE_RESTORE');
      expect((await received(s.stream, 'deleteRestore')).op.name).toBe('r-dev');
      s.stream.cancel();
    });

    it('needs a recently re-authenticated session and is not open to a token', async () => {
      const s = await setup(items());
      const token = (
        (await s.call('post', `/orgs/${s.orgId}/tokens`, { name: 't' }).expect(201)).body as {
          token: string;
        }
      ).token;
      await harness
        .api()
        .delete(`/api/v1${s.base}/restores/r-dev`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      const actor = await world.actAs(s.userId);
      await harness.app
        .get(SessionService)
        .update((actor as unknown as { sessionId: string }).sessionId, {
          lastReauthAt: Date.now() - 10 * 60 * 1_000,
        });
      expect(
        (await actor('delete', `${s.base}/restores/r-dev`).expect(403)).body.sudoRequired,
      ).toBe(true);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('is for cluster administrators', async () => {
      const s = await setup(items());
      const restorer = await member(s.call, s.orgId, s.agent, 'RESTORER', whole);
      await restorer.call('delete', `${s.base}/restores/r-dev`).expect(403);
      s.stream.cancel();
    });

    it('lets a scoped administrator delete only restores wholly inside their scope, and answers 404 for the rest', async () => {
      const s = await setup(items());
      const dev = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', only('dev'));
      const fromProd = await dev.call('delete', `${s.base}/restores/r-from-prod`).expect(404);
      const all = await dev.call('delete', `${s.base}/restores/r-all`).expect(404);
      const missing = await dev.call('delete', `${s.base}/restores/nope`).expect(404);
      expect(fromProd.body.detail).toBe(missing.body.detail);
      expect(all.body.detail).toBe(missing.body.detail);
      expect(await silent(s.stream)).toBe(true);

      await dev.call('delete', `${s.base}/restores/r-dev`).expect(202);
      expect((await received(s.stream, 'deleteRestore')).op.name).toBe('r-dev');
      s.stream.cancel();
    });

    it('rejects a bad name and another organization’s cluster', async () => {
      const s = await setup(items());
      await s.call('delete', `${s.base}/restores/Bad..Name`).expect(422);
      const other = await s.call('post', '/orgs', { name: 'Other', slug: 'other' }).expect(201);
      const clusterId = s.base.split('/')[4] ?? '';
      await s
        .call('delete', `/orgs/${other.body.id as string}/clusters/${clusterId}/restores/r-dev`)
        .expect(404);
      await s
        .call('post', `/orgs/${other.body.id as string}/clusters/${clusterId}/restores`, {
          backupName: 'b',
        })
        .expect(404);
      s.stream.cancel();
    });
  });
});
