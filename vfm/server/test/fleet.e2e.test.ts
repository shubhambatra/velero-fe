/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- response bodies are navigated as untyped JSON on purpose: the tests assert on their shape */
import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * The fleet overview and a cluster's overview (M3 day 18), read from inventory that a
 * fake agent really sent over gRPC. Permissions are decided per cluster and a section
 * the caller may not read is `null`, never a zero.
 */
const SCHEDULE = ResourceKind.RESOURCE_KIND_SCHEDULE;
const BSL = ResourceKind.RESOURCE_KIND_BACKUP_STORAGE_LOCATION;
const RESTORE = ResourceKind.RESOURCE_KIND_RESTORE;

describe('fleet and cluster overview (e2e)', () => {
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

  /** Connects an agent and gets a snapshot applied; resolves once it is. */
  async function populate(agent: Agent, snapshotId: string, items: ReturnType<typeof resource>[]) {
    const stream = await world.connect(agent);
    stream.send({ messageId: 's', snapshot: { snapshotId, sequence: 0, last: true, items } });
    await eventually(
      () =>
        harness.prisma.unscoped('t', () =>
          harness.prisma.cluster.findUniqueOrThrow({ where: { id: agent.clusterId } }),
        ),
      (c) => c.inventorySnapshotId === snapshotId,
    );
    return stream;
  }

  const richInventory = () => [
    resource('b-old', {
      phase: 'Completed',
      status: { completionTimestamp: '2026-10-15T01:03:00Z' },
    }),
    resource('b-new', {
      phase: 'PartiallyFailed',
      status: { completionTimestamp: '2026-10-16T01:03:00Z' },
    }),
    resource('b-running', { phase: 'InProgress', status: { completionTimestamp: undefined } }),
    resource('good-sched', { kind: SCHEDULE, phase: 'Enabled' }),
    resource('bad-sched', { kind: SCHEDULE, phase: 'FailedValidation' }),
    resource('default', {
      kind: BSL,
      phase: 'Available',
      spec: { provider: 'aws', default: true, accessMode: 'ReadWrite' },
      status: { lastValidationTime: '2026-10-16T05:00:00Z' },
    }),
    resource('offsite', {
      kind: BSL,
      phase: 'Unavailable',
      spec: { provider: 'gcp' },
      status: { message: 'permission denied' },
    }),
    resource('r1', {
      kind: RESTORE,
      phase: 'Completed',
      status: { startTimestamp: '2026-10-16T02:00:00Z' },
    }),
  ];

  const get = async (call: Call, path: string) =>
    (await call('get', path).expect(200)).body as Record<string, any>;

  it('summarises each cluster’s backups, schedules and storage', async () => {
    const { call, orgId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await populate(agent, 's1', richInventory());

    const { clusters } = await get(call, `/orgs/${orgId}/fleet`);
    expect(clusters).toHaveLength(1);
    const c = clusters[0];
    expect(c.name).toBe('prod-eu');
    expect(c.status).toBe('CONNECTED');
    expect(c.backups.total).toBe(3);
    expect(c.backups.byPhase).toEqual({ Completed: 1, PartiallyFailed: 1, InProgress: 1 });
    // The most recent *finished* backup, not the one still running.
    expect(c.backups.last).toMatchObject({ name: 'b-new', phase: 'PartiallyFailed' });
    expect(c.schedules).toEqual({ total: 2, failing: 1 });
    expect(c.storage).toEqual({ total: 2, available: 1, unavailable: 1 });
    expect(c.syncedAt).not.toBeNull();
    stream.cancel();
  });

  it('shows a cluster that has never reported with zero counts and no last backup', async () => {
    const { call, orgId } = await world.admin();
    await world.agent(call, orgId, 'fresh');
    const { clusters } = await get(call, `/orgs/${orgId}/fleet`);
    expect(clusters[0].status).toBe('ENROLLED');
    expect(clusters[0].backups).toEqual({ total: 0, byPhase: {}, last: null });
    expect(clusters[0].storage).toEqual({ total: 0, available: 0, unavailable: 0 });
    expect(clusters[0].syncedAt).toBeNull();
  });

  it('keeps each cluster’s numbers its own', async () => {
    const { call, orgId } = await world.admin();
    const one = await world.agent(call, orgId, 'one');
    const two = await world.agent(call, orgId, 'two');
    const a = await populate(one, 'sa', [resource('x1'), resource('x2')]);
    const b = await populate(two, 'sb', [resource('y1', { phase: 'Failed' })]);

    const { clusters } = await get(call, `/orgs/${orgId}/fleet`);
    const byName = Object.fromEntries(clusters.map((c: any) => [c.name, c]));
    expect(byName.one.backups.total).toBe(2);
    expect(byName.two.backups.byPhase).toEqual({ Failed: 1 });
    a.cancel();
    b.cancel();
  });

  it('lists only the clusters the caller may see', async () => {
    const { call, orgId } = await world.admin();
    const shown = await world.agent(call, orgId, 'shown');
    await world.agent(call, orgId, 'hidden');
    const dev = await world.member(call, orgId, 'dev@acme.test');

    expect((await get(dev.call, `/orgs/${orgId}/fleet`)).clusters).toEqual([]);

    await call('post', `/clusters/${shown.clusterId}/role-bindings`, {
      subjectType: 'USER',
      subjectId: dev.userId,
      role: 'VIEWER',
      scope: { type: 'CLUSTER' },
    }).expect(201);
    const { clusters } = await get(dev.call, `/orgs/${orgId}/fleet`);
    expect(clusters.map((c: any) => c.name)).toEqual(['shown']);
  });

  it('gives a non-member nothing', async () => {
    const { call, orgId } = await world.admin();
    const other = await call('post', '/orgs', { name: 'Other', slug: 'other' }).expect(201);
    const otherId = (other.body as { id: string }).id;
    await world.agent(call, orgId, 'acme-only');
    await call('post', '/me/active-org', { orgId: otherId }).expect(204);
    expect((await get(call, `/orgs/${otherId}/fleet`)).clusters).toEqual([]);
  });

  it('answers null, not zero, for sections an API token may not read', async () => {
    const { call, orgId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await populate(agent, 's1', richInventory());

    const make = async (permissions: string[]) =>
      (
        (
          await call('post', `/orgs/${orgId}/tokens`, {
            name: permissions.join('+'),
            permissions,
          }).expect(201)
        ).body as { token: string }
      ).token;
    const fleetWith = async (token: string) =>
      (
        await harness
          .api()
          .get(`/api/v1/orgs/${orgId}/fleet`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body as {
        clusters: any[];
      };

    const bare = (await fleetWith(await make(['cluster:read']))).clusters[0];
    expect(bare.name).toBe('prod-eu');
    expect(bare.backups).toBeNull();
    expect(bare.schedules).toBeNull();
    expect(bare.storage).toBeNull();

    const some = (await fleetWith(await make(['cluster:read', 'storage:read']))).clusters[0];
    expect(some.backups).toBeNull();
    expect(some.storage).toEqual({ total: 2, available: 1, unavailable: 1 });
    stream.cancel();
  });

  describe('a cluster’s overview', () => {
    it('reports health, storage locations and recent activity', async () => {
      const { call, orgId } = await world.admin();
      const agent = await world.agent(call, orgId, 'prod-eu');
      const stream = await populate(agent, 's1', richInventory());

      const o = await get(call, `/orgs/${orgId}/clusters/${agent.clusterId}/overview`);
      expect(o.cluster.name).toBe('prod-eu');
      expect(o.cluster.status).toBe('CONNECTED');
      expect(o.cluster.agentPolicy).toMatchObject({ allowRestore: true });
      expect(o.inventory.snapshotId).toBe('s1');
      expect(o.inventory.kinds.BACKUP.total).toBe(3);

      expect(o.locations).toEqual([
        {
          name: 'default',
          provider: 'aws',
          isDefault: true,
          phase: 'Available',
          message: null,
          lastValidated: '2026-10-16T05:00:00Z',
          accessMode: 'ReadWrite',
        },
        {
          name: 'offsite',
          provider: 'gcp',
          isDefault: false,
          phase: 'Unavailable',
          message: 'permission denied',
          lastValidated: null,
          accessMode: null,
        },
      ]);
      expect(o.recentBackups).toHaveLength(3);
      expect(o.recentBackups.every((b: any) => typeof b.name === 'string')).toBe(true);
      expect(o.recentRestores.map((r: any) => r.name)).toEqual(['r1']);
      stream.cancel();
    });

    it('omits what the caller may not read', async () => {
      const { call, orgId } = await world.admin();
      const agent = await world.agent(call, orgId, 'prod-eu');
      const stream = await populate(agent, 's1', richInventory());
      const token = (
        (
          await call('post', `/orgs/${orgId}/tokens`, {
            name: 'n',
            permissions: ['cluster:read', 'restore:read'],
          }).expect(201)
        ).body as { token: string }
      ).token;

      const o = (
        await harness
          .api()
          .get(`/api/v1/orgs/${orgId}/clusters/${agent.clusterId}/overview`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body as Record<string, any>;
      expect(o.locations).toBeNull();
      expect(o.recentBackups).toBeNull();
      expect(o.recentRestores).toHaveLength(1);
      expect(Object.keys(o.inventory.kinds)).toEqual(expect.arrayContaining(['RESTORE']));
      expect(Object.keys(o.inventory.kinds)).not.toContain('BACKUP');
      stream.cancel();
    });

    it('is 404 for a cluster that is not in the org, and for one the caller cannot see', async () => {
      const { call, orgId } = await world.admin();
      const agent = await world.agent(call, orgId, 'prod-eu');
      await call(
        'get',
        `/orgs/${orgId}/clusters/00000000-0000-7000-8000-00000000dead/overview`,
      ).expect(404);
      const dev = await world.member(call, orgId, 'dev@acme.test');
      await dev.call('get', `/orgs/${orgId}/clusters/${agent.clusterId}/overview`).expect(404);
    });
  });
});
