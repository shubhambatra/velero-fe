/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions -- response bodies are navigated as untyped JSON on purpose: the tests assert on their shape */
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../src/common/uuid';
import { reportOptions } from '../src/reports/reports.service';
import { createTestApp, type TestApp } from './app-harness';
import { World, type Call } from './world';

/**
 * M6 day 34: the reports against real Postgres. Data is seeded the way the agent leaves it
 * and every expected number below was worked out by hand (the working is in the comments),
 * which is the exit criterion: "reports match hand-computed values on seeded data".
 */
const H = 3_600_000;
const utc = (s: string): Date => new Date(`${s}Z`);

describe('reports (e2e)', () => {
  let h: TestApp;
  let world: World;

  beforeAll(async () => {
    h = await createTestApp();
    world = new World(h);
    await world.init();
  }, 60_000);

  afterAll(async () => {
    world.close();
    await h.close();
  });

  beforeEach(async () => {
    await h.reset();
  });

  async function org(name = 'prod-eu') {
    const { call, orgId, userId } = await world.admin();
    const clusterId = (await call('post', `/orgs/${orgId}/clusters`, { name }).expect(201)).body
      .cluster.id as string;
    return { call, orgId, userId, clusterId };
  }

  async function seed(
    orgId: string,
    clusterId: string,
    kind: string,
    name: string,
    over: Record<string, unknown> = {},
  ) {
    await h.prisma.inOrg(orgId, () =>
      h.prisma.veleroResource.create({
        data: {
          id: newId(),
          orgId,
          clusterId,
          kind,
          namespace: 'velero',
          name,
          uid: randomUUID(),
          resourceVersion: '1',
          ...over,
        } as any,
      }),
    );
  }
  const backup = (
    orgId: string,
    clusterId: string,
    name: string,
    phase: string,
    at: Date,
    extra: Record<string, unknown> = {},
  ) =>
    seed(orgId, clusterId, 'BACKUP', name, {
      phase,
      completedAt: at,
      creationTimestamp: at,
      ...extra,
    });
  const get = (call: Call, orgId: string, path: string) =>
    call('get', `/orgs/${orgId}/reports/${path}`);

  describe('success rate', () => {
    it('counts each outcome in its day, per cluster and in total (worked out by hand)', async () => {
      const a = await org('alpha');
      const b = (await a.call('post', `/orgs/${a.orgId}/clusters`, { name: 'beta' }).expect(201))
        .body.cluster.id;
      // alpha, 10 Oct: 2 Completed, 1 Failed, 1 PartiallyFailed          -> 2 / 4 = 50 %
      //        11 Oct: nothing finished                                  -> null
      //        12 Oct: 1 Completed, 1 FailedValidation                   -> 1 / 2 = 50 %
      // beta,  10 Oct: 3 Completed                                       -> 100 %
      //        12 Oct: 1 Failed                                          -> 0 %
      const alpha = (n: string, phase: string, at: string) =>
        backup(a.orgId, a.clusterId, n, phase, utc(at));
      await alpha('a1', 'Completed', '2026-10-10T02:00');
      await alpha('a2', 'Completed', '2026-10-10T14:00');
      await alpha('a3', 'Failed', '2026-10-10T20:00');
      await alpha('a4', 'PartiallyFailed', '2026-10-10T23:59:59');
      await alpha('a5', 'FailedValidation', '2026-10-12T01:00');
      await alpha('a6', 'Completed', '2026-10-12T02:00');
      for (const [i, hh] of ['01', '02', '03'].entries()) {
        await backup(a.orgId, b, `b${i}`, 'Completed', utc(`2026-10-10T${hh}:00`));
      }
      await backup(a.orgId, b, 'b9', 'Failed', utc('2026-10-12T05:00'));
      // Not outcomes, or outside the window: none of these may change a number.
      await alpha('x1', 'InProgress', '2026-10-10T05:00');
      await alpha('x2', 'Completed', '2026-10-09T23:59:59');
      await alpha('x3', 'Completed', '2026-10-13T00:00');
      // A backup that has since expired and been deleted still happened.
      await backup(a.orgId, a.clusterId, 'gone', 'Failed', utc('2026-10-12T10:00'), {
        deletedAt: utc('2026-10-12T12:00'),
      });

      const r = (
        await get(
          a.call,
          a.orgId,
          'success-rate?from=2026-10-10T00:00:00Z&to=2026-10-13T00:00:00Z',
        ).expect(200)
      ).body;
      const row = (c: string) => r.clusters.find((x: any) => x.clusterName === c);
      const short = (p: any) => [
        p.start.slice(0, 10),
        p.completed,
        p.partiallyFailed,
        p.failed,
        p.rate,
      ];
      // alpha 12 Oct is now 1 Completed, 2 Failed (FailedValidation and the deleted one): 1 / 3.
      expect(row('alpha').points.map(short)).toEqual([
        ['2026-10-10', 2, 1, 1, 0.5],
        ['2026-10-11', 0, 0, 0, null],
        ['2026-10-12', 1, 0, 2, 1 / 3],
      ]);
      expect(row('alpha').totals).toEqual({
        completed: 3,
        partiallyFailed: 1,
        failed: 3,
        rate: 3 / 7,
      });
      expect(row('beta').points.map(short)).toEqual([
        ['2026-10-10', 3, 0, 0, 1],
        ['2026-10-11', 0, 0, 0, null],
        ['2026-10-12', 0, 0, 1, 0],
      ]);
      // Together: 10 Oct 5 Completed, 1 Partial, 1 Failed = 5 / 7; 12 Oct 1 Completed, 3 Failed = 1 / 4.
      expect(r.all.points.map(short)).toEqual([
        ['2026-10-10', 5, 1, 1, 5 / 7],
        ['2026-10-11', 0, 0, 0, null],
        ['2026-10-12', 1, 0, 3, 0.25],
      ]);
      expect(r.all.totals).toEqual({ completed: 6, partiallyFailed: 1, failed: 4, rate: 6 / 11 });
      expect(r.incomplete).toBe(false);
    });

    it('buckets by week from Monday', async () => {
      const { call, orgId, clusterId } = await org();
      await backup(orgId, clusterId, 'w1', 'Completed', utc('2026-10-14T01:00')); // Wednesday
      await backup(orgId, clusterId, 'w2', 'Failed', utc('2026-10-20T01:00')); // next Tuesday
      await backup(orgId, clusterId, 'w3', 'Completed', utc('2026-10-21T01:00'));
      const r = (
        await get(
          call,
          orgId,
          'success-rate?bucket=week&from=2026-10-14T00:00:00Z&to=2026-10-25T00:00:00Z',
        ).expect(200)
      ).body;
      expect(r.all.points.map((p: any) => [p.start.slice(0, 10), p.completed, p.failed])).toEqual([
        ['2026-10-12', 1, 0],
        ['2026-10-19', 1, 1],
      ]);
    });

    it('narrows to one cluster, and a cluster that is not yours is not found', async () => {
      const a = await org('alpha');
      const b = (await a.call('post', `/orgs/${a.orgId}/clusters`, { name: 'beta' }).expect(201))
        .body.cluster.id;
      await backup(a.orgId, a.clusterId, 'x', 'Failed', utc('2026-10-10T01:00'));
      await backup(a.orgId, b, 'y', 'Completed', utc('2026-10-10T01:00'));
      const q = 'from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z';
      const one = (await get(a.call, a.orgId, `success-rate?${q}&clusterId=${b}`).expect(200)).body;
      expect(one.clusters.map((c: any) => c.clusterName)).toEqual(['beta']);
      expect(one.all.totals.rate).toBe(1);
      await get(a.call, a.orgId, `success-rate?${q}&clusterId=${randomUUID()}`).expect(404);
    });

    it('validates its window and its parameters', async () => {
      const { call, orgId } = await org();
      await get(
        call,
        orgId,
        'success-rate?from=2026-10-12T00:00:00Z&to=2026-10-10T00:00:00Z',
      ).expect(400);
      await get(
        call,
        orgId,
        'success-rate?from=2024-01-01T00:00:00Z&to=2026-10-10T00:00:00Z',
      ).expect(400);
      await get(call, orgId, 'success-rate?bucket=hour').expect(422);
      await get(call, orgId, 'success-rate?from=yesterday').expect(422);
      await get(call, orgId, 'success-rate?format=xml').expect(422);
      await get(call, orgId, 'success-rate?surprise=1').expect(422);
      await get(call, orgId, 'success-rate').expect(200);
    });
  });

  describe('namespaces without a recent backup', () => {
    async function ns(orgId: string, clusterId: string, names: string[]) {
      for (const n of names)
        await seed(orgId, clusterId, 'NAMESPACE', n, { namespace: '', phase: 'Active' });
    }
    const hoursAgo = (n: number) => new Date(Date.now() - n * H);

    it('lists those whose newest successful backup is older than the limit, or that have none', async () => {
      const { call, orgId, clusterId } = await org();
      await ns(orgId, clusterId, ['shop', 'billing', 'scratch', 'kube-system']);
      // shop: backed up 10 h ago. billing: 100 h ago. scratch: never. kube-system: 60 h ago.
      await backup(orgId, clusterId, 'shop-now', 'Completed', hoursAgo(10), {
        spec: { includedNamespaces: ['shop'] },
      });
      await backup(orgId, clusterId, 'billing-old', 'Completed', hoursAgo(100), {
        spec: { includedNamespaces: ['billing'] },
      });
      await backup(orgId, clusterId, 'kube-old', 'Completed', hoursAgo(60), {
        spec: { includedNamespaces: ['kube-system'] },
      });
      // None of these cover anything: not finished, failed, or deleted.
      await backup(orgId, clusterId, 'failed', 'Failed', hoursAgo(1), {
        spec: { includedNamespaces: ['scratch'] },
      });
      await backup(orgId, clusterId, 'running', 'InProgress', hoursAgo(1), {
        spec: { includedNamespaces: ['scratch'] },
      });
      await backup(orgId, clusterId, 'deleted', 'Completed', hoursAgo(1), {
        spec: { includedNamespaces: ['scratch'] },
        deletedAt: new Date(),
      });

      const at = async (hours: number) =>
        (
          (await get(call, orgId, `coverage?hours=${hours}`).expect(200)).body.clusters[0]
            .namespaces as any[]
        ).map((n) => [n.namespace, n.hoursSince === null ? null : Math.round(n.hoursSince)]);
      // 48 h: billing (100), kube-system (60) and scratch (never) are stale; shop (10) is fine.
      // Never-backed-up first, then the longest neglected.
      expect(await at(48)).toEqual([
        ['scratch', null],
        ['billing', 100],
        ['kube-system', 60],
      ]);
      expect(await at(80)).toEqual([
        ['scratch', null],
        ['billing', 100],
      ]);
      expect(await at(200)).toEqual([['scratch', null]]);
      const full = (await get(call, orgId, 'coverage?hours=48').expect(200)).body;
      expect(full.clusters[0].total).toBe(4);
      expect(full.hours).toBe(48);
    });

    it('says whether a schedule covers the namespace', async () => {
      const { call, orgId, clusterId } = await org();
      await ns(orgId, clusterId, ['shop', 'billing']);
      await seed(orgId, clusterId, 'SCHEDULE', 'nightly', {
        spec: { schedule: '0 2 * * *', template: { includedNamespaces: ['shop'] } },
      });
      const r = (await get(call, orgId, 'coverage?hours=1').expect(200)).body.clusters[0]
        .namespaces;
      expect(Object.fromEntries(r.map((n: any) => [n.namespace, n.scheduled]))).toEqual({
        shop: true,
        billing: false,
      });
    });
  });

  describe('RPO compliance', () => {
    const S = utc('2026-10-01T02:00');
    const at = (hours: number) => new Date(S.getTime() + hours * H);
    const q = `from=${S.toISOString()}&to=${at(144).toISOString()}`;

    async function nightly(orgId: string, clusterId: string, name = 'nightly', spec: object = {}) {
      await seed(orgId, clusterId, 'SCHEDULE', name, {
        spec: { schedule: '0 2 * * *', ...spec },
        creationTimestamp: utc('2026-09-01T00:00'),
      });
    }

    it('works out the time within the objective by hand', async () => {
      const { call, orgId, clusterId } = await org();
      await nightly(orgId, clusterId);
      // Window: 1 Oct 02:00 to 7 Oct 02:00 = 144 h. Successes at +0, +96 h, +120 h.
      // Objective: 1.5 x 24 h = 36 h.
      //   +0   .. +96  : 96 h long, the first 36 h within the objective
      //   +96  .. +120 : 24 h, all within
      //   +120 .. +144 : 24 h to the end, all within
      // 84 h of 144 h = 58.33 %; the longest gap is 96 h; two successes inside the window.
      for (const [i, hrs] of [0, 96, 120].entries()) {
        await backup(orgId, clusterId, `n${i}`, 'Completed', at(hrs), {
          labels: { 'velero.io/schedule-name': 'nightly' },
        });
      }
      // None of these count as a success of the schedule.
      await backup(orgId, clusterId, 'failed', 'Failed', at(40), {
        labels: { 'velero.io/schedule-name': 'nightly' },
      });
      await backup(orgId, clusterId, 'other', 'Completed', at(40), {
        labels: { 'velero.io/schedule-name': 'weekly' },
      });
      await backup(orgId, clusterId, 'manual', 'Completed', at(40));

      const r = (await get(call, orgId, `rpo?${q}`).expect(200)).body;
      expect(r.schedules).toHaveLength(1);
      const s = r.schedules[0];
      expect(s).toMatchObject({
        clusterName: 'prod-eu',
        schedule: 'nightly',
        cron: '0 2 * * *',
        targetHours: 36,
        measuredHours: 144,
        compliantHours: 84,
        longestGapHours: 96,
        successes: 2,
        ageHours: 24,
        metNow: true,
        lastSuccessAt: at(120).toISOString(),
      });
      expect(s.compliance).toBeCloseTo(84 / 144, 10);
    });

    it('takes the objective from the request, for every schedule', async () => {
      const { call, orgId, clusterId } = await org();
      await nightly(orgId, clusterId);
      for (const [i, hrs] of [0, 96, 120].entries()) {
        await backup(orgId, clusterId, `n${i}`, 'Completed', at(hrs), {
          labels: { 'velero.io/schedule-name': 'nightly' },
        });
      }
      // With 100 h every stretch (96, 24, 24) is within the objective: 100 %.
      const loose = (await get(call, orgId, `rpo?${q}&targetHours=100`).expect(200)).body
        .schedules[0];
      expect(loose).toMatchObject({ targetHours: 100, compliantHours: 144, compliance: 1 });
      // With 12 h: 12 + 12 + 12 = 36 h of 144 h.
      const tight = (await get(call, orgId, `rpo?${q}&targetHours=12`).expect(200)).body
        .schedules[0];
      expect(tight.compliantHours).toBe(36);
      expect(tight.metNow).toBe(false);
      // Factor 3 on a 24 h schedule is 72 h: 72 + 24 + 24 = 120 h.
      expect(
        (await get(call, orgId, `rpo?${q}&factor=3`).expect(200)).body.schedules[0].compliantHours,
      ).toBe(120);
    });

    it('leaves out paused schedules and ones with nothing to measure against, and puts the worst first', async () => {
      const { call, orgId, clusterId } = await org();
      await nightly(orgId, clusterId, 'good');
      await nightly(orgId, clusterId, 'bad');
      await nightly(orgId, clusterId, 'paused', { paused: true });
      await seed(orgId, clusterId, 'SCHEDULE', 'broken', {
        spec: { schedule: 'nonsense' },
        creationTimestamp: utc('2026-09-01T00:00'),
      });
      for (let i = 0; i <= 6; i += 1) {
        await backup(orgId, clusterId, `g${i}`, 'Completed', at(i * 24), {
          labels: { 'velero.io/schedule-name': 'good' },
        });
      }
      await backup(orgId, clusterId, 'b0', 'Completed', at(0), {
        labels: { 'velero.io/schedule-name': 'bad' },
      });
      const names = (await get(call, orgId, `rpo?${q}`).expect(200)).body.schedules.map(
        (s: any) => s.schedule,
      );
      expect(names).toEqual(['bad', 'good']);
    });

    it('does not credit a schedule with the backups of a schedule of the same name in another namespace', async () => {
      const { call, orgId, clusterId } = await org();
      const created = { creationTimestamp: utc('2026-09-01T00:00') };
      await seed(orgId, clusterId, 'SCHEDULE', 'nightly', {
        spec: { schedule: '0 2 * * *' },
        ...created,
      });
      await seed(orgId, clusterId, 'SCHEDULE', 'nightly', {
        namespace: 'velero-b',
        spec: { schedule: '0 2 * * *' },
        ...created,
      });
      for (let hrs = 0; hrs <= 144; hrs += 24) {
        await backup(orgId, clusterId, `a${hrs}`, 'Completed', at(hrs), {
          labels: { 'velero.io/schedule-name': 'nightly' },
        });
      }
      const rows = (await get(call, orgId, `rpo?${q}`).expect(200)).body.schedules as any[];
      expect(rows).toHaveLength(2);
      // The one in `velero` has its seven daily backups; the one in `velero-b` has none.
      expect(rows[0]).toMatchObject({ compliance: 0, successes: 0 });
      expect(rows[1]).toMatchObject({ compliance: 1, successes: 6 });
    });

    it('gives a new schedule one objective to make its first backup', async () => {
      const { call, orgId, clusterId } = await org();
      await seed(orgId, clusterId, 'SCHEDULE', 'new', {
        spec: { schedule: '0 2 * * *' },
        creationTimestamp: at(120),
      });
      // Created at +120 h with no backup yet: 24 h measured to +144 h, all within 36 h.
      const s = (await get(call, orgId, `rpo?${q}`).expect(200)).body.schedules[0];
      expect(s).toMatchObject({
        measuredHours: 24,
        compliance: 1,
        successes: 0,
        lastSuccessAt: null,
        ageHours: null,
        metNow: true,
      });
    });
  });

  describe('who sees what', () => {
    async function scopedViewer(
      call: Call,
      orgId: string,
      clusterId: string,
      namespaces: string[],
    ) {
      const user = await world.member(
        call,
        orgId,
        `v-${Math.random().toString(36).slice(2, 7)}@acme.test`,
      );
      await call('post', `/clusters/${clusterId}/role-bindings`, {
        subjectType: 'USER',
        subjectId: user.userId,
        role: 'VIEWER',
        scope: { type: 'NAMESPACES', namespaces },
      }).expect(201);
      return user;
    }

    it('limits a namespace-scoped person to the backups, schedules and namespaces they may read', async () => {
      const { call, orgId, clusterId } = await org();
      for (const n of ['shop', 'billing'])
        await seed(orgId, clusterId, 'NAMESPACE', n, { namespace: '', phase: 'Active' });
      const when = utc('2026-10-10T10:00');
      await backup(orgId, clusterId, 'shop-ok', 'Completed', when, {
        spec: { includedNamespaces: ['shop'] },
      });
      await backup(orgId, clusterId, 'shop-bad', 'Failed', when, {
        spec: { includedNamespaces: ['shop'] },
      });
      await backup(orgId, clusterId, 'billing-bad', 'Failed', when, {
        spec: { includedNamespaces: ['billing'] },
      });
      await backup(orgId, clusterId, 'everything-bad', 'Failed', when, { spec: {} });
      await seed(orgId, clusterId, 'SCHEDULE', 'shop-nightly', {
        spec: { schedule: '0 2 * * *', template: { includedNamespaces: ['shop'] } },
        creationTimestamp: utc('2026-09-01T00:00'),
      });
      await seed(orgId, clusterId, 'SCHEDULE', 'billing-nightly', {
        spec: { schedule: '0 2 * * *', template: { includedNamespaces: ['billing'] } },
        creationTimestamp: utc('2026-09-01T00:00'),
      });
      const v = await scopedViewer(call, orgId, clusterId, ['shop']);
      const win = 'from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z';

      // The admin sees four finished backups: 1 of 4 succeeded. The viewer sees the two of shop only.
      expect(
        (await get(call, orgId, `success-rate?${win}`).expect(200)).body.all.totals,
      ).toMatchObject({ completed: 1, failed: 3 });
      const mine = (await get(v.call, orgId, `success-rate?${win}`).expect(200)).body;
      expect(mine.all.totals).toEqual({ completed: 1, partiallyFailed: 0, failed: 1, rate: 0.5 });

      const cov = (await get(v.call, orgId, 'coverage?hours=1').expect(200)).body.clusters[0];
      expect(cov.total).toBe(1);
      expect(cov.namespaces.map((n: any) => n.namespace)).toEqual(['shop']);
      expect(JSON.stringify(cov)).not.toContain('billing');

      const rpo = (
        await get(v.call, orgId, 'rpo?from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z').expect(
          200,
        )
      ).body;
      expect(rpo.schedules.map((s: any) => s.schedule)).toEqual(['shop-nightly']);
    });

    it('shares an answer between people who see the same things, and never with someone who sees less', async () => {
      const { call, orgId, clusterId } = await org();
      const when = utc('2026-10-10T10:00');
      await backup(orgId, clusterId, 'shop-ok', 'Completed', when, {
        spec: { includedNamespaces: ['shop'] },
      });
      await backup(orgId, clusterId, 'billing-bad', 'Failed', when, {
        spec: { includedNamespaces: ['billing'] },
      });
      const v = await scopedViewer(call, orgId, clusterId, ['shop']);
      const win = 'from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z';
      const before = reportOptions.resultCacheMs;
      reportOptions.resultCacheMs = 60_000;
      try {
        const first = (await get(call, orgId, `success-rate?${win}`).expect(200)).body;
        expect(first.all.totals).toMatchObject({ completed: 1, failed: 1 });

        // The scoped viewer is asked after the admin was answered: their numbers are their own.
        const mine = (await get(v.call, orgId, `success-rate?${win}`).expect(200)).body;
        expect(mine.all.totals).toMatchObject({ completed: 1, failed: 0 });

        // A later backup is not in the shared answer yet (that is the sharing), but the scoped
        // viewer still does not get the admin's.
        await backup(orgId, clusterId, 'shop-bad', 'Failed', when, {
          spec: { includedNamespaces: ['shop'] },
        });
        const again = (await get(call, orgId, `success-rate?${win}`).expect(200)).body;
        expect(again.all.totals).toEqual(first.all.totals);
        const mineAgain = (await get(v.call, orgId, `success-rate?${win}`).expect(200)).body;
        expect(mineAgain.all.totals).toEqual(mine.all.totals);
        expect(JSON.stringify(mineAgain)).not.toContain('billing');
      } finally {
        reportOptions.resultCacheMs = before;
      }
      // With the sharing off the new backup shows at once.
      const fresh = (await get(call, orgId, `success-rate?${win}`).expect(200)).body;
      expect(fresh.all.totals).toMatchObject({ completed: 1, failed: 2 });
    });

    it('gives a member with no access to any cluster nothing at all', async () => {
      const { call, orgId, clusterId } = await org();
      await backup(orgId, clusterId, 'x', 'Failed', utc('2026-10-10T10:00'));
      const nobody = await world.member(call, orgId, 'nobody@acme.test');
      const win = 'from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z';
      expect(
        (await get(nobody.call, orgId, `success-rate?${win}`).expect(200)).body.clusters,
      ).toEqual([]);
      expect((await get(nobody.call, orgId, 'coverage').expect(200)).body.clusters).toEqual([]);
      expect((await get(nobody.call, orgId, `rpo?${win}`).expect(200)).body.schedules).toEqual([]);
      await get(nobody.call, orgId, `success-rate?${win}&clusterId=${clusterId}`).expect(404);
    });

    it('never mixes organizations, and hides an org from anyone outside it', async () => {
      const a = await org('alpha');
      await backup(a.orgId, a.clusterId, 'mine', 'Completed', utc('2026-10-10T10:00'));
      const other = await h.prisma.organization.create({
        data: { id: newId(), name: 'B', slug: 'b' } as any,
      });
      const theirs = await h.prisma.inOrg(other.id, () =>
        h.prisma.cluster.create({ data: { id: newId(), orgId: other.id, name: 'theirs' } as any }),
      );
      for (let i = 0; i < 5; i += 1)
        await backup(other.id, theirs.id, `t${i}`, 'Failed', utc('2026-10-10T10:00'));
      const r = (
        await get(
          a.call,
          a.orgId,
          'success-rate?from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z',
        ).expect(200)
      ).body;
      expect(r.clusters.map((c: any) => c.clusterName)).toEqual(['alpha']);
      expect(r.all.totals).toMatchObject({ completed: 1, failed: 0 });
      const outsider = await world.actAs(
        (
          await h.prisma.user.create({
            data: { id: newId(), email: 'x@x.test', passwordHash: 'x' } as any,
          })
        ).id,
      );
      await get(outsider, a.orgId, 'success-rate').expect(404);
      await get(outsider, a.orgId, 'coverage').expect(404);
      await get(outsider, a.orgId, 'rpo').expect(404);
    });
  });

  describe('CSV', () => {
    it('is the same data as a spreadsheet, with a header, the right type, and formulas defused', async () => {
      const { call, orgId, clusterId } = await org();
      await h.prisma.inOrg(orgId, () =>
        h.prisma.cluster.update({
          where: { id: clusterId },
          data: { name: '=HYPERLINK("http://evil.example","x")' },
        }),
      );
      await backup(orgId, clusterId, 'a', 'Completed', utc('2026-10-10T01:00'));
      await backup(orgId, clusterId, 'b', 'Failed', utc('2026-10-10T02:00'));
      const res = await get(
        call,
        orgId,
        'success-rate?format=csv&from=2026-10-10T00:00:00Z&to=2026-10-11T00:00:00Z',
      ).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="success-rate.csv"');
      const lines = res.text.trim().split('\r\n');
      expect(lines[0]).toBe(
        'cluster,period_start,completed,partially_failed,failed,success_rate_percent',
      );
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe(
        '"\'=HYPERLINK(""http://evil.example"",""x"")",2026-10-10T00:00:00.000Z,1,0,1,50',
      );
    });

    it('has a CSV for each report, with their columns', async () => {
      const { call, orgId, clusterId } = await org();
      await seed(orgId, clusterId, 'NAMESPACE', 'scratch', { namespace: '', phase: 'Active' });
      await seed(orgId, clusterId, 'SCHEDULE', 'nightly', {
        spec: { schedule: '0 2 * * *' },
        creationTimestamp: utc('2026-09-01T00:00'),
      });
      const cov = await get(call, orgId, 'coverage?format=csv&hours=24').expect(200);
      expect(cov.text.trim().split('\r\n')).toEqual([
        'cluster,namespace,last_successful_backup,hours_since,has_schedule',
        'prod-eu,scratch,,,true',
      ]);
      const rpo = await get(
        call,
        orgId,
        'rpo?format=csv&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z',
      ).expect(200);
      const lines = rpo.text.trim().split('\r\n');
      expect(lines[0]).toBe(
        'cluster,schedule,cron,objective_hours,compliance_percent,measured_hours,compliant_hours,longest_gap_hours,successful_backups,last_successful_backup,age_hours,objective_met_now',
      );
      expect(lines[1]).toMatch(/^prod-eu,nightly,0 2 \* \* \*,36,0,24,0,744,0,,,false$/);
    });

    it('is audited, as the data leaving the system that it is', async () => {
      const { call, orgId, clusterId } = await org();
      await backup(orgId, clusterId, 'a', 'Completed', utc('2026-10-10T01:00'));
      await get(
        call,
        orgId,
        'success-rate?format=csv&from=2026-10-10T00:00:00Z&to=2026-10-12T00:00:00Z',
      ).expect(200);
      await new Promise((r) => setTimeout(r, 200));
      const audit = (await call('get', `/orgs/${orgId}/audit`).expect(200)).body.events as any[];
      const row = audit.find((e) => e.action === 'reports.export.success-rate');
      expect(row).toBeDefined();
      expect(row.details).toMatchObject({ rows: 2 });
    });
  });
});
