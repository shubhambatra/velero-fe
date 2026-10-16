import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceEventType, ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import { hello, makeClient, openStream, type OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, tombstone, World, type Agent } from './world';

/**
 * M3 day 17 — inventory ingest — against real PostgreSQL, Redis, gRPC and mTLS, with
 * a fake agent that sends exactly what each test says. What is proven: a snapshot is
 * applied atomically or not at all, deltas apply only against the snapshot that is
 * current and in order, anything else is refused and answered with a request for a new
 * snapshot, and nothing an agent sends is stored unvalidated or filed under another
 * object's identity.
 */
const SCHEDULE = ResourceKind.RESOURCE_KIND_SCHEDULE;

describe('inventory ingest (e2e)', () => {
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

  const rows = (clusterId: string, includeDeleted = false) =>
    harness.prisma.unscoped('test', () =>
      harness.prisma.veleroResource.findMany({
        where: { clusterId, ...(includeDeleted ? {} : { deletedAt: null }) },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      }),
    );

  const names = async (clusterId: string): Promise<string[]> =>
    (await rows(clusterId)).map((r) => r.name);

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

  const snapshot = (
    agent: OpenStream,
    id: string,
    chunks: ReturnType<typeof resource>[][],
    options: { omitLast?: boolean } = {},
  ): void => {
    chunks.forEach((items, i) => {
      agent.send({
        messageId: `${id}-${i.toString()}`,
        snapshot: {
          snapshotId: id,
          sequence: i,
          last: options.omitLast === true ? false : i === chunks.length - 1,
          items,
        },
      });
    });
  };

  async function setup(): Promise<{
    agent: Agent;
    stream: OpenStream;
    call: Awaited<ReturnType<World['admin']>>['call'];
    orgId: string;
  }> {
    const { call, orgId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    return { agent, stream: await world.connect(agent), call, orgId };
  }

  const snapshotIdOf = async (clusterId: string): Promise<string | null> =>
    (
      await harness.prisma.unscoped('t', () =>
        harness.prisma.cluster.findUniqueOrThrow({ where: { id: clusterId } }),
      )
    ).inventorySnapshotId;

  describe('snapshots', () => {
    it('applies a multi-chunk snapshot and extracts the columns', async () => {
      const { agent, stream } = await setup();
      snapshot(stream, 's1', [
        [resource('b1'), resource('b2', { phase: 'InProgress' })],
        [resource('nightly', { kind: SCHEDULE, phase: 'Enabled' })],
      ]);

      await eventually(
        'the snapshot',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's1',
      );
      const all = await rows(agent.clusterId);
      expect(all.map((r) => `${r.kind}:${r.name}:${r.phase ?? ''}`)).toEqual([
        'BACKUP:b1:Completed',
        'BACKUP:b2:InProgress',
        'SCHEDULE:nightly:Enabled',
      ]);
      expect(all[0]?.startedAt?.toISOString()).toBe('2026-10-16T01:00:05.000Z');
      expect(all[0]?.orgId).toBeDefined();
      expect(all[0]?.snapshotId).toBe('s1');
      stream.cancel();
    });

    it('applies an empty snapshot by clearing the cluster', async () => {
      const { agent, stream } = await setup();
      snapshot(stream, 's1', [[resource('b1')]]);
      await eventually(
        's1',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's1',
      );

      snapshot(stream, 's2', [[]]);
      await eventually(
        's2',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's2',
      );
      expect(await names(agent.clusterId)).toEqual([]);
      // Soft deleted, not erased.
      expect((await rows(agent.clusterId, true)).map((r) => r.deletedAt !== null)).toEqual([true]);
      stream.cancel();
    });

    it('keeps the old inventory visible until the new snapshot is complete, then swaps', async () => {
      const { agent, stream } = await setup();
      snapshot(stream, 'old', [[resource('a'), resource('b')]]);
      await eventually(
        'old',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 'old',
      );

      // The first chunk of a new snapshot arrives; the last has not.
      snapshot(stream, 'new', [[resource('b'), resource('c')], [resource('d')]], {
        omitLast: true,
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(await names(agent.clusterId)).toEqual(['a', 'b']);
      expect(await snapshotIdOf(agent.clusterId)).toBe('old');

      stream.send({
        messageId: 'x',
        snapshot: { snapshotId: 'new', sequence: 2, last: true, items: [] },
      });
      await eventually(
        'new',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 'new',
      );
      expect(await names(agent.clusterId)).toEqual(['b', 'c', 'd']);
      // `a` is gone from the live view but its row is kept.
      expect(
        (await rows(agent.clusterId, true)).find((r) => r.name === 'a')?.deletedAt,
      ).not.toBeNull();
      stream.cancel();
    });

    it('discards a snapshot that never finished when the stream ends', async () => {
      const { agent, stream } = await setup();
      snapshot(stream, 's1', [[resource('b1')], [resource('b2')]], { omitLast: true });
      await new Promise((r) => setTimeout(r, 200));
      stream.cancel();
      await stream.ended;

      // The next connection's state is clean: continuing the old snapshot is refused.
      const again = await world.connect(agent);
      again.send({
        messageId: 'late',
        snapshot: { snapshotId: 's1', sequence: 2, last: true, items: [] },
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(await names(agent.clusterId)).toEqual([]);
      expect(await snapshotIdOf(agent.clusterId)).toBeNull();
      again.cancel();
    });

    it('refuses a chunk out of sequence and asks the agent for a new snapshot', async () => {
      const { agent, stream } = await setup();
      stream.send({
        messageId: 'x',
        snapshot: { snapshotId: 'sX', sequence: 1, last: true, items: [resource('b1')] },
      });

      const ask = (await stream.next()).resync;
      expect(ask?.reason).toContain('out of sequence');
      expect(await names(agent.clusterId)).toEqual([]);
      stream.cancel();
    });

    it('lets a newer snapshot supersede one still arriving', async () => {
      const { agent, stream } = await setup();
      snapshot(stream, 'abandoned', [[resource('ghost')]], { omitLast: true });
      snapshot(stream, 'fresh', [[resource('real')]]);
      await eventually(
        'fresh',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 'fresh',
      );
      expect(await names(agent.clusterId)).toEqual(['real']);
      stream.cancel();
    });

    it('revives an object that was removed and then recreated under the same name', async () => {
      const { agent, stream } = await setup();
      snapshot(stream, 's1', [[resource('b1', { uid: 'first-life' })]]);
      await eventually(
        's1',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's1',
      );
      snapshot(stream, 's2', [[]]);
      await eventually(
        's2',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's2',
      );

      snapshot(stream, 's3', [[resource('b1', { uid: 'second-life' })]]);
      await eventually(
        's3',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's3',
      );
      const [row] = await rows(agent.clusterId);
      expect(row?.uid).toBe('second-life');
      expect(row?.deletedAt).toBeNull();
      expect(await rows(agent.clusterId, true)).toHaveLength(1);
      stream.cancel();
    });

    it('writes only what changed at a routine resync', async () => {
      const { agent, stream } = await setup();
      snapshot(stream, 's1', [[resource('b1'), resource('b2')]]);
      await eventually(
        's1',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's1',
      );
      const before = await rows(agent.clusterId);

      snapshot(stream, 's2', [[resource('b1'), resource('b2', { phase: 'Failed', rv: '2' })]]);
      await eventually(
        's2',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's2',
      );
      const after = await rows(agent.clusterId);

      expect(after.find((r) => r.name === 'b2')?.phase).toBe('Failed');
      // The unchanged object was left alone: not rewritten under the new snapshot.
      expect(after.find((r) => r.name === 'b1')?.snapshotId).toBe('s1');
      expect(after.find((r) => r.name === 'b1')?.updatedAt).toEqual(
        before.find((r) => r.name === 'b1')?.updatedAt,
      );
      stream.cancel();
    });
  });

  describe('deltas', () => {
    async function applied() {
      const ctx = await setup();
      snapshot(ctx.stream, 's1', [[resource('b1'), resource('b2')]]);
      await eventually(
        's1',
        () => snapshotIdOf(ctx.agent.clusterId),
        (id) => id === 's1',
      );
      return ctx;
    }

    it('upserts, updates and deletes against the current snapshot, in order', async () => {
      const { agent, stream } = await applied();
      stream.send({
        messageId: 'e1',
        events: {
          snapshotId: 's1',
          batchSequence: 1,
          events: [
            { type: ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT, item: resource('b3') },
            {
              type: ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT,
              item: resource('b1', { phase: 'Failed', rv: '2' }),
            },
            { type: ResourceEventType.RESOURCE_EVENT_TYPE_DELETE, item: tombstone('b2') },
          ],
        },
      });

      await eventually(
        'the delta',
        () => names(agent.clusterId),
        (n) => n.join() === 'b1,b3',
      );
      expect((await rows(agent.clusterId)).find((r) => r.name === 'b1')?.phase).toBe('Failed');
      stream.cancel();
    });

    it('ignores a replayed batch', async () => {
      const { agent, stream } = await applied();
      const batch = {
        messageId: 'e1',
        events: {
          snapshotId: 's1',
          batchSequence: 1,
          events: [{ type: ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT, item: resource('b3') }],
        },
      };
      stream.send(batch);
      await eventually(
        'b3',
        () => names(agent.clusterId),
        (n) => n.includes('b3'),
      );
      // The same batch again, now with a changed object that must not be applied.
      stream.send({
        ...batch,
        events: {
          ...batch.events,
          events: [
            {
              type: ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT,
              item: resource('b3', { phase: 'Failed', rv: '9' }),
            },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 250));
      expect((await rows(agent.clusterId)).find((r) => r.name === 'b3')?.phase).toBe('Completed');
      stream.cancel();
    });

    it('refuses a delta for a snapshot that is not applied and asks for a new one', async () => {
      const { agent, stream } = await applied();
      stream.send({
        messageId: 'e1',
        events: {
          snapshotId: 'some-other-snapshot',
          batchSequence: 1,
          events: [
            { type: ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT, item: resource('intruder') },
          ],
        },
      });
      expect((await stream.next()).resync?.reason).toContain('not applied');
      expect(await names(agent.clusterId)).toEqual(['b1', 'b2']);
      stream.cancel();
    });

    it('treats a gap in the batch sequence as lost data: refuses it, asks again, and ignores deltas until a new snapshot', async () => {
      const { agent, stream } = await applied();
      stream.send({
        messageId: 'gap',
        events: {
          snapshotId: 's1',
          batchSequence: 5,
          events: [
            { type: ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT, item: resource('after-gap') },
          ],
        },
      });
      expect((await stream.next()).resync?.reason).toContain('out of sequence');

      // Even a correctly numbered batch is not trusted until the agent resyncs.
      stream.send({
        messageId: 'next',
        events: {
          snapshotId: 's1',
          batchSequence: 1,
          events: [
            {
              type: ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT,
              item: resource('still-untrusted'),
            },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 250));
      expect(await names(agent.clusterId)).toEqual(['b1', 'b2']);

      snapshot(stream, 's2', [[resource('b1'), resource('after-gap')]]);
      await eventually(
        's2',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's2',
      );
      expect(await names(agent.clusterId)).toEqual(['after-gap', 'b1']);
      stream.cancel();
    });

    it('does not let a stale delete remove an object recreated under the same name', async () => {
      const { agent, stream } = await applied();
      stream.send({
        messageId: 'e1',
        events: {
          snapshotId: 's1',
          batchSequence: 1,
          events: [
            {
              type: ResourceEventType.RESOURCE_EVENT_TYPE_DELETE,
              item: tombstone('b1', 'an-earlier-incarnation'),
            },
          ],
        },
      });
      await new Promise((r) => setTimeout(r, 250));
      expect(await names(agent.clusterId)).toEqual(['b1', 'b2']);
      stream.cancel();
    });
  });

  describe('what an agent may not do', () => {
    it('has bad items refused while the good ones in the same snapshot are applied', async () => {
      const { agent, stream } = await setup();
      const forged = resource('victim');
      // Filed as `victim` but the object inside is named `other`.
      forged.objectJson = Buffer.from(
        JSON.stringify({
          kind: 'Backup',
          metadata: { name: 'other', namespace: 'velero', uid: 'uid-victim' },
        }),
      );
      snapshot(stream, 's1', [
        [
          resource('good'),
          forged,
          resource('a-pod', { kind: ResourceKind.RESOURCE_KIND_POD }),
          { ...resource('bad name'), name: '../../etc' },
          { ...resource('big'), objectJson: Buffer.alloc(300 * 1024, 0x20) },
          resource('also-good', { kind: SCHEDULE, phase: 'Enabled' }),
        ],
      ]);
      await eventually(
        's1',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's1',
      );
      expect((await names(agent.clusterId)).sort()).toEqual(['also-good', 'good']);
      stream.cancel();
    });

    it('cannot write another cluster’s inventory: state is the authenticated stream’s', async () => {
      const { call, orgId } = await world.admin();
      const one = await world.agent(call, orgId, 'one');
      const two = await world.agent(call, orgId, 'two');
      const a = await world.connect(one);
      const b = await world.connect(two);

      snapshot(a, 'sa', [[resource('only-in-one')]]);
      snapshot(b, 'sb', [[resource('only-in-two')]]);
      await eventually(
        'both',
        async () => [await snapshotIdOf(one.clusterId), await snapshotIdOf(two.clusterId)],
        (ids) => ids.join() === 'sa,sb',
      );

      expect(await names(one.clusterId)).toEqual(['only-in-one']);
      expect(await names(two.clusterId)).toEqual(['only-in-two']);

      // Two's agent now replaces its own inventory; one is untouched.
      snapshot(b, 'sb2', [[]]);
      await eventually(
        'sb2',
        () => snapshotIdOf(two.clusterId),
        (id) => id === 'sb2',
      );
      expect(await names(one.clusterId)).toEqual(['only-in-one']);
      a.cancel();
      b.cancel();
    });

    it('does not apply inventory sent by an agent whose stream was never accepted', async () => {
      const { call, orgId } = await world.admin();
      const agent = await world.agent(call, orgId, 'prod-eu');
      // A Hello with the wrong fingerprint is refused, so nothing after it can be heard.
      const stream = openStream(makeClient(world.port, world.caPem, agent.cert, world.clients));
      stream.send(hello({ clusterFingerprint: 'some-other-cluster' }));
      stream.send({
        messageId: 's',
        snapshot: { snapshotId: 'evil', sequence: 0, last: true, items: [resource('evil')] },
      });
      await stream.ended;
      expect(await names(agent.clusterId)).toEqual([]);
    });
  });

  describe('the read model', () => {
    it('reports counts by kind and phase, and when it was last synced', async () => {
      const { agent, stream, call, orgId } = await setup();
      snapshot(stream, 's1', [
        [
          resource('b1'),
          resource('b2', { phase: 'Failed' }),
          resource('b3'),
          resource('nightly', { kind: SCHEDULE, phase: 'Enabled' }),
        ],
      ]);
      await eventually(
        's1',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's1',
      );

      const res = await call('get', `/orgs/${orgId}/clusters/${agent.clusterId}/inventory`).expect(
        200,
      );
      expect(res.body.snapshotId).toBe('s1');
      expect(new Date(res.body.syncedAt as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(res.body.kinds.BACKUP).toEqual({ total: 3, byPhase: { Completed: 2, Failed: 1 } });
      expect(res.body.kinds.SCHEDULE).toEqual({ total: 1, byPhase: { Enabled: 1 } });
      stream.cancel();
    });

    it('omits kinds the caller may not read rather than reporting zero', async () => {
      const { agent, stream, call, orgId } = await setup();
      snapshot(stream, 's1', [
        [resource('b1'), resource('nightly', { kind: SCHEDULE, phase: 'Enabled' })],
      ]);
      await eventually(
        's1',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's1',
      );

      // A token limited to cluster:read and backup:read: it may see backups, not schedules.
      const narrow = await call('post', `/orgs/${orgId}/tokens`, {
        name: 'narrow',
        permissions: ['cluster:read', 'backup:read'],
      }).expect(201);
      const res = await harness
        .api()
        .get(`/api/v1/orgs/${orgId}/clusters/${agent.clusterId}/inventory`)
        .set('Authorization', `Bearer ${narrow.body.token as string}`)
        .expect(200);
      expect(Object.keys(res.body.kinds as object)).toContain('BACKUP');
      expect(Object.keys(res.body.kinds as object)).not.toContain('SCHEDULE');
      expect(Object.keys(res.body.kinds as object)).not.toContain('BACKUP_STORAGE_LOCATION');

      const bare = await call('post', `/orgs/${orgId}/tokens`, {
        name: 'bare',
        permissions: ['cluster:read'],
      }).expect(201);
      const none = await harness
        .api()
        .get(`/api/v1/orgs/${orgId}/clusters/${agent.clusterId}/inventory`)
        .set('Authorization', `Bearer ${bare.body.token as string}`)
        .expect(200);
      expect(none.body.kinds).toEqual({});
      stream.cancel();
    });

    it('answers 404 for a cluster that is not the caller’s', async () => {
      const { call, orgId } = await world.admin();
      await call(
        'get',
        `/orgs/${orgId}/clusters/00000000-0000-7000-8000-00000000dead/inventory`,
      ).expect(404);
    });

    it('is removed with the cluster', async () => {
      const { agent, stream, call, orgId } = await setup();
      snapshot(stream, 's1', [[resource('b1')]]);
      await eventually(
        's1',
        () => snapshotIdOf(agent.clusterId),
        (id) => id === 's1',
      );
      await call('delete', `/orgs/${orgId}/clusters/${agent.clusterId}`).expect(204);
      expect(await rows(agent.clusterId, true)).toEqual([]);
    });
  });
});
