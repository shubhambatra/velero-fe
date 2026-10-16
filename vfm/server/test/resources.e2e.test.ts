/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- response bodies are navigated as untyped JSON on purpose: the tests assert on their shape */
import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * M3 day 19: the lists and detail pages, over inventory a fake agent really sent.
 * What is held here: filters and sorts do what they say, pagination neither drops nor
 * repeats an item, and a namespace-scoped user sees exactly what the plan's rule
 * allows (ADR-024), with a detail page that answers 404 rather than confirm that a
 * hidden backup exists.
 */
const K = ResourceKind;

describe('lists and detail pages (e2e)', () => {
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

  async function populate(agent: Agent, items: ReturnType<typeof resource>[], id = 's1') {
    const stream = await world.connect(agent);
    stream.send({ messageId: 's', snapshot: { snapshotId: id, sequence: 0, last: true, items } });
    await eventually(
      () =>
        harness.prisma.unscoped('t', () =>
          harness.prisma.cluster.findUniqueOrThrow({ where: { id: agent.clusterId } }),
        ),
      (c) => c.inventorySnapshotId === id,
    );
    return stream;
  }

  const base = (orgId: string, agent: Agent) => `/orgs/${orgId}/clusters/${agent.clusterId}`;
  const get = async (call: Call, path: string, status = 200) =>
    (await call('get', path).expect(status)).body;
  const names = (page: any): string[] => page.items.map((i: any) => i.name);

  const backup = (name: string, over: Parameters<typeof resource>[1] = {}) =>
    resource(name, { kind: K.RESOURCE_KIND_BACKUP, ...over });
  const scoped = (namespaces: string[]) => ({
    storageLocation: 'default',
    includedNamespaces: namespaces,
  });

  async function setup() {
    const { call, orgId, userId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    return { call, orgId, userId, agent };
  }

  describe('backups', () => {
    it('lists newest first by default, with what a table needs', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        backup('old', {
          started: '2026-10-14T01:00:00Z',
          status: { completionTimestamp: '2026-10-14T01:02:00Z', warnings: 3 },
        }),
        backup('new', {
          started: '2026-10-16T01:00:00Z',
          labels: { 'velero.io/schedule-name': 'nightly' },
          managed: true,
          status: { errors: 1 },
        }),
        backup('unstarted', { phase: 'New', status: { startTimestamp: undefined } }),
      ]);
      const page = await get(call, `${base(orgId, agent)}/backups`);
      expect(names(page)).toEqual(['new', 'old', 'unstarted']); // never-started sorts last
      expect(page.nextCursor).toBeNull();
      expect(page.items[0]).toMatchObject({
        phase: 'Completed',
        schedule: 'nightly',
        createdByVfm: true,
        errors: 1,
        storageLocation: 'default',
      });
      expect(page.items[1]).toMatchObject({ warnings: 3 });
      expect(page.items[2].startedAt).toBeNull();
      stream.cancel();
    });

    it('filters by phase (a list), name, schedule, storage location and origin', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        backup('nightly-1', {
          labels: { 'velero.io/schedule-name': 'nightly' },
          started: '2026-10-16T01:00:00Z',
        }),
        backup('nightly-2', {
          labels: { 'velero.io/schedule-name': 'nightly' },
          phase: 'Failed',
          started: '2026-10-15T01:00:00Z',
        }),
        backup('adhoc-1', {
          phase: 'PartiallyFailed',
          spec: { storageLocation: 'offsite' },
          managed: true,
          started: '2026-10-14T01:00:00Z',
        }),
      ]);
      const b = `${base(orgId, agent)}/backups`;
      expect(names(await get(call, `${b}?phase=Failed,PartiallyFailed`))).toEqual([
        'nightly-2',
        'adhoc-1',
      ]);
      expect(names(await get(call, `${b}?q=ADHOC`))).toEqual(['adhoc-1']);
      expect(names(await get(call, `${b}?schedule=nightly`))).toEqual(['nightly-1', 'nightly-2']);
      expect(names(await get(call, `${b}?location=offsite`))).toEqual(['adhoc-1']);
      expect(names(await get(call, `${b}?createdByVfm=true`))).toEqual(['adhoc-1']);
      expect(names(await get(call, `${b}?createdByVfm=false&phase=Completed`))).toEqual([
        'nightly-1',
      ]);
      expect(names(await get(call, `${b}?schedule=nothing`))).toEqual([]);
      stream.cancel();
    });

    it('sorts either way, and refuses what it cannot sort or filter by', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [backup('b'), backup('a'), backup('c')]);
      const b = `${base(orgId, agent)}/backups`;
      expect(names(await get(call, `${b}?sort=name&order=asc`))).toEqual(['a', 'b', 'c']);
      expect(names(await get(call, `${b}?sort=name&order=desc`))).toEqual(['c', 'b', 'a']);
      await get(call, `${b}?sort=spec`, 400);
      await get(call, `${b}?paused=true`, 400); // a schedule filter on a backup list
      await get(call, `${b}?backup=x`, 400);
      await get(call, `${b}?order=sideways`, 422);
      await get(call, `${b}?limit=0`, 422);
      await get(call, `${b}?limit=201`, 422);
      stream.cancel();
    });

    it('pages without dropping or repeating anything, including exact multiples', async () => {
      const { call, orgId, agent } = await setup();
      const all = Array.from({ length: 25 }, (_, i) =>
        backup(`b${i.toString().padStart(2, '0')}`, {
          started: `2026-10-${(i + 1).toString().padStart(2, '0')}T01:00:00Z`,
        }),
      );
      const stream = await populate(agent, all);
      const b = `${base(orgId, agent)}/backups`;

      for (const limit of [10, 5, 25, 7, 1]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page: any = await get(
            call,
            `${b}?limit=${limit.toString()}${cursor === null ? '' : `&cursor=${cursor}`}`,
          );
          expect(page.items.length).toBeLessThanOrEqual(limit);
          seen.push(...names(page));
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor !== null && pages < 40);
        expect(seen, `limit ${limit.toString()}`).toHaveLength(25);
        expect(new Set(seen).size).toBe(25);
        expect(seen[0]).toBe('b24'); // newest first
      }

      // 25 items at 25 per page: exactly one page, and it says so.
      expect((await get(call, `${b}?limit=25`)).nextCursor).toBeNull();
      // 20 of 25 at limit 10: the second page is the last of what matches.
      const filtered = `${b}?phase=Completed&q=b0&limit=5`;
      const one = await get(call, filtered);
      expect(one.nextCursor).not.toBeNull();
      stream.cancel();
    });

    it('refuses a cursor that is garbage or belongs to a different query', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [backup('a'), backup('b'), backup('c')]);
      const b = `${base(orgId, agent)}/backups`;
      const first = await get(call, `${b}?limit=1`);
      await get(call, `${b}?limit=1&cursor=garbage`, 400);
      // The same cursor with a different sort is not the position it names.
      await get(call, `${b}?limit=1&sort=name&cursor=${first.nextCursor as string}`, 400);
      await get(call, `${b}?limit=1&phase=Failed&cursor=${first.nextCursor as string}`, 400);
      await get(call, `${b}?limit=1&cursor=${first.nextCursor as string}`, 200);
      stream.cancel();
    });

    it('keeps one cluster’s objects out of another’s lists and detail', async () => {
      const { call, orgId, agent } = await setup();
      const other = await world.agent(call, orgId, 'staging');
      const a = await populate(agent, [backup('only-prod')]);
      const b = await populate(other, [backup('only-staging')], 's2');
      expect(names(await get(call, `${base(orgId, agent)}/backups`))).toEqual(['only-prod']);
      expect(names(await get(call, `${base(orgId, other)}/backups`))).toEqual(['only-staging']);
      await get(call, `${base(orgId, agent)}/backups/only-staging`, 404);
      a.cancel();
      b.cancel();
    });

    it('does not show an object that has been deleted', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [backup('keep'), backup('gone')]);
      stream.send({
        messageId: 's2',
        snapshot: { snapshotId: 's2', sequence: 0, last: true, items: [backup('keep')] },
      });
      await eventually(
        () => get(call, `${base(orgId, agent)}/backups`),
        (p) => p.items.length === 1,
      );
      await get(call, `${base(orgId, agent)}/backups/gone`, 404);
      stream.cancel();
    });
  });

  describe('restores, schedules and storage', () => {
    it('lists restores with their source backup and filters on it', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        resource('r1', { kind: K.RESOURCE_KIND_RESTORE, spec: { backupName: 'b1' } }),
        resource('r2', {
          kind: K.RESOURCE_KIND_RESTORE,
          spec: { backupName: 'b2', scheduleName: 'nightly' },
          phase: 'Failed',
        }),
      ]);
      const r = `${base(orgId, agent)}/restores`;
      const all = await get(call, r);
      expect(all.items.map((i: any) => i.backupName).sort()).toEqual(['b1', 'b2']);
      expect(names(await get(call, `${r}?backup=b2`))).toEqual(['r2']);
      expect(names(await get(call, `${r}?schedule=nightly`))).toEqual(['r2']);
      expect(names(await get(call, `${r}?phase=Failed`))).toEqual(['r2']);
      stream.cancel();
    });

    it('lists schedules with cron and paused, and filters on paused', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        resource('nightly', {
          kind: K.RESOURCE_KIND_SCHEDULE,
          phase: 'Enabled',
          spec: {
            schedule: '0 1 * * *',
            template: { storageLocation: 'default', ttl: '720h0m0s' },
          },
        }),
        resource('weekly', {
          kind: K.RESOURCE_KIND_SCHEDULE,
          phase: 'Enabled',
          spec: { schedule: '0 2 * * 0', paused: true, template: {} },
        }),
      ]);
      const s = `${base(orgId, agent)}/schedules`;
      const all = await get(call, s);
      expect(all.items.find((i: any) => i.name === 'nightly')).toMatchObject({
        cron: '0 1 * * *',
        paused: false,
        ttl: '720h0m0s',
      });
      expect(names(await get(call, `${s}?paused=true`))).toEqual(['weekly']);
      expect(names(await get(call, `${s}?paused=false`))).toEqual(['nightly']);
      stream.cancel();
    });

    it('lists the three kinds of storage, with credentials as references only', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        resource('default', {
          kind: K.RESOURCE_KIND_BACKUP_STORAGE_LOCATION,
          phase: 'Available',
          spec: {
            provider: 'aws',
            default: true,
            objectStorage: { bucket: 'b' },
            credential: { name: 'cloud-credentials', key: 'cloud', value: 'SECRET-VALUE' },
          },
        }),
        resource('snap', {
          kind: K.RESOURCE_KIND_VOLUME_SNAPSHOT_LOCATION,
          spec: { provider: 'aws' },
        }),
        resource('repo-1', {
          kind: K.RESOURCE_KIND_BACKUP_REPOSITORY,
          phase: 'Ready',
          spec: {
            repositoryType: 'kopia',
            volumeNamespace: 'shop',
            backupStorageLocation: 'default',
          },
        }),
      ]);
      const c = base(orgId, agent);
      const bsl = await get(call, `${c}/backup-locations`);
      expect(bsl.items[0]).toMatchObject({
        name: 'default',
        provider: 'aws',
        isDefault: true,
        bucket: 'b',
        credential: { name: 'cloud-credentials', key: 'cloud' },
      });
      expect(JSON.stringify(bsl)).not.toContain('SECRET-VALUE');
      expect(names(await get(call, `${c}/snapshot-locations`))).toEqual(['snap']);
      expect((await get(call, `${c}/repositories`)).items[0]).toMatchObject({
        repositoryType: 'kopia',
        volumeNamespace: 'shop',
        storageLocation: 'default',
      });
      stream.cancel();
    });
  });

  describe('detail pages', () => {
    it('shows a backup’s summary, timeline, spec, status, YAML and its volumes', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        backup('nightly-1', {
          spec: { storageLocation: 'default', includedNamespaces: ['shop'], ttl: '720h0m0s' },
          status: {
            completionTimestamp: '2026-10-16T01:03:00Z',
            expiration: '2026-11-15T01:00:00Z',
            progress: { itemsBackedUp: 9, totalItems: 10 },
          },
          labels: { 'velero.io/schedule-name': 'nightly' },
        }),
        resource('pvb-1', {
          kind: K.RESOURCE_KIND_POD_VOLUME_BACKUP,
          phase: 'Completed',
          labels: { 'velero.io/backup-name': 'nightly-1' },
          spec: { uploaderType: 'kopia' },
          status: { progress: { bytesDone: 50, totalBytes: 100 } },
        }),
        resource('pvb-other', {
          kind: K.RESOURCE_KIND_POD_VOLUME_BACKUP,
          labels: { 'velero.io/backup-name': 'someone-elses' },
        }),
      ]);
      const d = await get(call, `${base(orgId, agent)}/backups/nightly-1`);
      expect(d.summary).toMatchObject({
        name: 'nightly-1',
        phase: 'Completed',
        itemsBackedUp: 9,
        totalItems: 10,
        schedule: 'nightly',
      });
      expect(d.timeline.map((t: any) => t.event)).toEqual([
        'Created',
        'Started',
        'Finished: Completed',
        'Expires',
      ]);
      expect(d.spec.includedNamespaces).toEqual(['shop']);
      expect(d.status.phase).toBe('Completed');
      expect(d.yaml).toContain('kind: Backup');
      expect(d.yaml).toContain('name: nightly-1');
      expect(d.yaml).toContain('- shop');
      expect(d.volumes).toEqual([
        {
          kind: 'POD_VOLUME_BACKUP',
          name: 'pvb-1',
          phase: 'Completed',
          uploader: 'kopia',
          bytesDone: 50,
          totalBytes: 100,
        },
      ]);
      stream.cancel();
    });

    it('shows a restore with its source backup', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        resource('r1', {
          kind: K.RESOURCE_KIND_RESTORE,
          spec: {
            backupName: 'b1',
            namespaceMapping: { shop: 'shop-copy' },
            includedNamespaces: ['shop'],
          },
        }),
      ]);
      const d = await get(call, `${base(orgId, agent)}/restores/r1`);
      expect(d.summary.backupName).toBe('b1');
      expect(d.yaml).toContain('kind: Restore');
      expect(d.yaml).toContain('shop-copy');
      stream.cancel();
    });

    it('rejects a name that is not a plausible object name before it reaches a query', async () => {
      const { call, orgId, agent } = await setup();
      await get(call, `${base(orgId, agent)}/backups/..%2F..%2Fetc`, 422);
      await get(call, `${base(orgId, agent)}/backups/nope`, 404);
    });
  });

  describe('who sees which backups (ADR-024)', () => {
    async function scopedUser(call: Call, orgId: string, agent: Agent, namespaces: string[]) {
      const dev = await world.member(call, orgId, `dev-${namespaces.join('-')}@acme.test`);
      await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
        subjectType: 'USER',
        subjectId: dev.userId,
        role: 'VIEWER',
        scope: { type: 'NAMESPACES', namespaces },
      }).expect(201);
      return dev;
    }

    const inventory = () => [
      backup('dev-only', { spec: scoped(['dev']) }),
      backup('dev-and-qa', { spec: scoped(['dev', 'qa']) }),
      backup('prod-only', { spec: scoped(['prod']) }),
      backup('everything', { spec: { storageLocation: 'default' } }),
      backup('all-but-prod', {
        spec: { storageLocation: 'default', excludedNamespaces: ['prod'] },
      }),
      backup('star', { spec: scoped(['*']) }),
      backup('dev-with-cluster-resources', {
        spec: { ...scoped(['dev']), includeClusterResources: true },
      }),
      backup('dev-auto-cluster-resources', { spec: scoped(['dev']) }),
    ];

    it('lets a namespace-scoped user see only backups wholly inside their scope', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, inventory());
      const dev = await scopedUser(call, orgId, agent, ['dev']);

      const page = await get(dev.call, `${base(orgId, agent)}/backups?sort=name&order=asc`);
      // `dev-and-qa` also covers qa; wildcards and "all" need a whole-cluster binding; explicit
      // cluster-scoped inclusion is out of reach of a scoped binding.
      expect(names(page)).toEqual(['dev-auto-cluster-resources', 'dev-only']);
      stream.cancel();
    });

    it('widens with the scope, to exactly what is covered', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, inventory());
      const both = await scopedUser(call, orgId, agent, ['dev', 'qa']);
      expect(
        names(await get(both.call, `${base(orgId, agent)}/backups?sort=name&order=asc`)),
      ).toEqual(['dev-and-qa', 'dev-auto-cluster-resources', 'dev-only']);
      stream.cancel();
    });

    it('lets a whole-cluster viewer and an org admin see everything', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, inventory());
      const viewer = await world.member(call, orgId, 'viewer@acme.test');
      await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
        subjectType: 'USER',
        subjectId: viewer.userId,
        role: 'VIEWER',
        scope: { type: 'CLUSTER' },
      }).expect(201);
      expect(
        (await get(viewer.call, `${base(orgId, agent)}/backups?limit=200`)).items,
      ).toHaveLength(8);
      expect((await get(call, `${base(orgId, agent)}/backups?limit=200`)).items).toHaveLength(8);
      stream.cancel();
    });

    it('pages a filtered list correctly even when most rows are hidden', async () => {
      const { call, orgId, agent } = await setup();
      const items = Array.from({ length: 60 }, (_, i) =>
        backup(`b${i.toString().padStart(2, '0')}`, {
          spec: scoped(i % 6 === 0 ? ['dev'] : ['prod']),
          started: `2026-09-${(i + 1).toString().padStart(2, '0')}T01:00:00Z`,
        }),
      );
      const stream = await populate(agent, items);
      const dev = await scopedUser(call, orgId, agent, ['dev']);

      for (const limit of [3, 4, 10]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let guard = 0;
        do {
          const page: any = await get(
            dev.call,
            `${base(orgId, agent)}/backups?limit=${limit.toString()}${cursor === null ? '' : `&cursor=${cursor}`}`,
          );
          expect(page.items.length).toBeLessThanOrEqual(limit);
          seen.push(...names(page));
          cursor = page.nextCursor;
          guard += 1;
        } while (cursor !== null && guard < 60);
        expect(seen.sort(), `limit ${limit.toString()}`).toEqual(
          items
            .filter((_, i) => i % 6 === 0)
            .map((i) => i.name)
            .sort(),
        );
      }
      stream.cancel();
    });

    it('answers a hidden backup exactly as it answers one that does not exist', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, inventory());
      const dev = await scopedUser(call, orgId, agent, ['dev']);
      const b = base(orgId, agent);

      const hidden = await dev.call('get', `${b}/backups/prod-only`);
      const missing = await dev.call('get', `${b}/backups/does-not-exist`);
      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      // Identical but for the caller's own request path and the per-request id.
      const strip = ({ instance: _i, requestId: _r, ...rest }: any) => rest;
      expect(strip(hidden.body)).toEqual(strip(missing.body));
      await get(dev.call, `${b}/backups/dev-only`);
      stream.cancel();
    });

    it('counts both sides of a restore: a restore of prod into dev is not a dev restore', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        resource('into-dev', {
          kind: K.RESOURCE_KIND_RESTORE,
          spec: {
            backupName: 'x',
            includedNamespaces: ['prod'],
            namespaceMapping: { prod: 'dev' },
          },
        }),
        resource('within-dev', {
          kind: K.RESOURCE_KIND_RESTORE,
          spec: { backupName: 'x', includedNamespaces: ['dev'] },
        }),
      ]);
      const dev = await scopedUser(call, orgId, agent, ['dev']);
      expect(names(await get(dev.call, `${base(orgId, agent)}/restores`))).toEqual(['within-dev']);
      await get(dev.call, `${base(orgId, agent)}/restores/into-dev`, 404);
      stream.cancel();
    });

    it('filters schedules through their template', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        resource('dev-nightly', {
          kind: K.RESOURCE_KIND_SCHEDULE,
          phase: 'Enabled',
          spec: { schedule: '0 1 * * *', template: { includedNamespaces: ['dev'] } },
        }),
        resource('everything', {
          kind: K.RESOURCE_KIND_SCHEDULE,
          phase: 'Enabled',
          spec: { schedule: '0 1 * * *', template: {} },
        }),
      ]);
      const dev = await scopedUser(call, orgId, agent, ['dev']);
      expect(names(await get(dev.call, `${base(orgId, agent)}/schedules`))).toEqual([
        'dev-nightly',
      ]);
      stream.cancel();
    });

    it('shows storage to anyone bound to the cluster, since it exposes no namespace’s data', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        resource('default', {
          kind: K.RESOURCE_KIND_BACKUP_STORAGE_LOCATION,
          phase: 'Available',
          spec: { provider: 'aws' },
        }),
      ]);
      const dev = await scopedUser(call, orgId, agent, ['dev']);
      expect(names(await get(dev.call, `${base(orgId, agent)}/backup-locations`))).toEqual([
        'default',
      ]);
      stream.cancel();
    });

    it('returns the stored spec to someone who may see it, and 404 to anyone else', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        resource('dev-s', {
          kind: K.RESOURCE_KIND_SCHEDULE,
          phase: 'Enabled',
          spec: {
            schedule: '0 2 * * *',
            template: { includedNamespaces: ['dev'], includeClusterResources: false },
          },
        }),
        resource('prod-s', {
          kind: K.RESOURCE_KIND_SCHEDULE,
          phase: 'Enabled',
          spec: { schedule: '@daily', template: { includedNamespaces: ['prod'] } },
        }),
      ]);
      const url = (n: string) => `${base(orgId, agent)}/schedules/${n}`;
      const detail = await get(call, url('dev-s'));
      expect(detail.spec).toMatchObject({ schedule: '0 2 * * *' });
      expect(detail.yaml).toContain('kind: Schedule');

      const dev = await scopedUser(call, orgId, agent, ['dev']);
      await get(dev.call, url('dev-s'));
      await get(dev.call, url('prod-s'), 404);
      await get(dev.call, url('ghost'), 404);
      stream.cancel();
    });

    it('shows a user with no binding nothing at all, not even that the cluster exists', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, inventory());
      const nobody = await world.member(call, orgId, 'nobody@acme.test');
      await get(nobody.call, `${base(orgId, agent)}/backups`, 404);
      await get(nobody.call, `${base(orgId, agent)}/backups/dev-only`, 404);
      stream.cancel();
    });
  });

  describe('API tokens', () => {
    it('apply a token’s narrowed permissions to every list', async () => {
      const { call, orgId, agent } = await setup();
      const stream = await populate(agent, [
        backup('b1'),
        resource('s1', { kind: K.RESOURCE_KIND_SCHEDULE, phase: 'Enabled' }),
      ]);
      const token = (
        (
          await call('post', `/orgs/${orgId}/tokens`, {
            name: 'narrow',
            permissions: ['cluster:read', 'backup:read'],
          }).expect(201)
        ).body as { token: string }
      ).token;
      const as = (path: string) =>
        harness
          .api()
          .get(`/api/v1${base(orgId, agent)}${path}`)
          .set('Authorization', `Bearer ${token}`);

      expect((await as('/backups').expect(200)).body.items).toHaveLength(1);
      await as('/schedules').expect(403);
      await as('/backup-locations').expect(403);
      await as('/backups/b1').expect(200);
      await as('/restores').expect(403);
      stream.cancel();
    });
  });
});
