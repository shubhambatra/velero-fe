/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions -- response bodies are navigated as untyped JSON on purpose: the tests assert on their shape */
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AlertEvaluator } from '../src/alerts/alert-evaluator';
import { AlertsService } from '../src/alerts/alerts.service';
import { AlertNotifier, type AlertNotification } from '../src/alerts/notifier';
import { SessionService } from '../src/auth/session.service';
import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { newId } from '../src/common/uuid';
import { createTestApp, type TestApp } from './app-harness';
import { World, type Call } from './world';

/**
 * M6 day 32: the alert engine against real Postgres and Redis. Data is seeded the way the
 * agent leaves it (rows in `velero_resources`, a cluster row), and the engine is driven by
 * hand with a chosen "now", so every rule type and every transition is deterministic.
 */
const NOW = new Date('2026-10-17T12:00:00Z');
const at = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);
const CHANNEL = randomUUID();

describe('alerts (e2e)', () => {
  let h: TestApp;
  let world: World;
  let engine: AlertsService;
  let notifier: AlertNotifier;
  let sent: AlertNotification[];
  let fail: boolean;

  beforeAll(async () => {
    h = await createTestApp();
    world = new World(h);
    await world.init();
    engine = h.app.get(AlertsService);
    notifier = h.app.get(AlertNotifier);
    vi.spyOn(notifier, 'notify').mockImplementation((n) => {
      if (fail) return Promise.reject(new Error('channel down'));
      sent.push(n);
      return Promise.resolve();
    });
  }, 60_000);

  afterAll(async () => {
    world.close();
    await h.close();
  });

  beforeEach(async () => {
    await h.reset();
    sent = [];
    fail = false;
  });

  async function org() {
    const { call, orgId, userId } = await world.admin();
    const created = await call('post', `/orgs/${orgId}/clusters`, { name: 'prod-eu' }).expect(201);
    return { call, orgId, userId, clusterId: created.body.cluster.id as string };
  }

  const rule = (call: Call, orgId: string, body: object) =>
    call('post', `/orgs/${orgId}/alerts/rules`, {
      name: 'rule',
      type: 'BACKUP_FAILED',
      channelIds: [CHANNEL],
      ...body,
    });

  const events = async (call: Call, orgId: string, query = '') =>
    (await call('get', `/orgs/${orgId}/alerts/events${query}`).expect(200)).body.events as any[];

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
    hoursAgo: number,
    extra: Record<string, unknown> = {},
  ) =>
    seed(orgId, clusterId, 'BACKUP', name, {
      phase,
      completedAt: at(hoursAgo),
      creationTimestamp: at(hoursAgo),
      ...extra,
    });

  describe('rules', () => {
    it('are managed by owners and admins only, reads included', async () => {
      const { call, orgId } = await org();
      const member = await world.member(call, orgId, 'm@acme.test');
      await member.call('get', `/orgs/${orgId}/alerts/rules`).expect(403);
      await member.call('get', `/orgs/${orgId}/alerts/events`).expect(403);
      await rule(member.call, orgId, {}).expect(403);
      await rule(call, orgId, {}).expect(201);
      await call('get', `/orgs/${orgId}/alerts/rules`).expect(200);
    });

    it('are invisible to people outside the org, and to other orgs', async () => {
      const a = await org();
      const created = await rule(a.call, a.orgId, {}).expect(201);
      const outsider = await world.actAs(
        (
          await h.prisma.user.create({
            data: { id: newId(), email: 'x@x.test', passwordHash: 'x' } as any,
          })
        ).id,
      );
      await outsider('get', `/orgs/${a.orgId}/alerts/rules`).expect(404);
      await outsider('patch', `/orgs/${a.orgId}/alerts/rules/${created.body.id}`, {
        enabled: false,
      }).expect(404);
      await outsider('delete', `/orgs/${a.orgId}/alerts/rules/${created.body.id}`).expect(404);
    });

    it('validate what they are given', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, { type: 'NOPE' }).expect(422);
      await rule(call, orgId, { name: '' }).expect(422);
      await rule(call, orgId, { extra: 1 }).expect(422);
      await rule(call, orgId, { type: 'AGENT_DISCONNECTED', params: { minutes: 0 } }).expect(400);
      await rule(call, orgId, { type: 'AGENT_DISCONNECTED', params: { minute: 5 } }).expect(400);
      await rule(call, orgId, { channelIds: ['not-a-uuid'] }).expect(422);
      await rule(call, orgId, { scope: { clusterIds: [randomUUID()] } }).expect(400);
      const ok = await rule(call, orgId, {
        type: 'AGENT_DISCONNECTED',
        scope: { clusterIds: [clusterId] },
      }).expect(201);
      expect(ok.body.params).toEqual({ minutes: 10, renotifyMinutes: 240 });
    });

    it('refuse a cluster of another org in their scope', async () => {
      const a = await org();
      const other = await h.prisma.organization.create({
        data: { id: newId(), name: 'B', slug: 'b' } as any,
      });
      const foreign = await h.prisma.inOrg(other.id, () =>
        h.prisma.cluster.create({ data: { id: newId(), orgId: other.id, name: 'theirs' } as any }),
      );
      await rule(a.call, a.orgId, { scope: { clusterIds: [foreign.id] } }).expect(400);
    });

    it('can be changed but not retyped, and are deleted with sudo', async () => {
      const { call, orgId, userId } = await org();
      const created = (await rule(call, orgId, {}).expect(201)).body;
      await call('patch', `/orgs/${orgId}/alerts/rules/${created.id}`, {
        type: 'BSL_UNAVAILABLE',
      }).expect(422);
      await call('patch', `/orgs/${orgId}/alerts/rules/${created.id}`, {}).expect(422);
      const changed = await call('patch', `/orgs/${orgId}/alerts/rules/${created.id}`, {
        name: 'renamed',
        params: { lookbackHours: 6 },
      }).expect(200);
      expect(changed.body).toMatchObject({ name: 'renamed', type: 'BACKUP_FAILED' });
      expect(changed.body.params.lookbackHours).toBe(6);

      const stale = await h.app
        .get(SessionService)
        .create({ userId, ip: '127.0.0.1', userAgent: 'v' });
      await h.app.get(SessionService).update(stale.id, { lastReauthAt: Date.now() - 10 * 60_000 });
      await h
        .api()
        .delete(`/api/v1/orgs/${orgId}/alerts/rules/${created.id}`)
        .set(
          'Cookie',
          `${SessionService.COOKIE}=${stale.id}; ${SessionService.CSRF_COOKIE}=${stale.csrfToken}`,
        )
        .set(CSRF_HEADER, stale.csrfToken)
        .expect(403);
      await call('delete', `/orgs/${orgId}/alerts/rules/${created.id}`).expect(204);
      await call('delete', `/orgs/${orgId}/alerts/rules/${created.id}`).expect(404);
    });

    it('are audited when created, changed and deleted', async () => {
      const { call, orgId } = await org();
      const created = (await rule(call, orgId, {}).expect(201)).body;
      await call('patch', `/orgs/${orgId}/alerts/rules/${created.id}`, { enabled: false }).expect(
        200,
      );
      await call('delete', `/orgs/${orgId}/alerts/rules/${created.id}`).expect(204);
      const audit = (await call('get', `/orgs/${orgId}/audit`).expect(200)).body.events as any[];
      const mine = audit.filter((e) => e.targetType === 'alert_rule' && e.targetId === created.id);
      expect(mine).toHaveLength(3);
      expect(mine.every((e) => e.outcome === 'SUCCESS')).toBe(true);
    });
  });

  describe('a failed backup', () => {
    it('fires once, is not repeated, and resolves when a later backup of the schedule completes', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, {}).expect(201);
      await backup(orgId, clusterId, 'nightly-1', 'Failed', 2, {
        labels: { 'velero.io/schedule-name': 'nightly' },
        status: { failureReason: 'BackupStorageLocation "default" is unavailable' },
      });

      expect(await engine.evaluateOrg(orgId, NOW)).toMatchObject({ fired: 1, resolved: 0 });
      const first = await events(call, orgId);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        state: 'FIRING',
        clusterName: 'prod-eu',
        ruleType: 'BACKUP_FAILED',
        fingerprint: 'backup-failed:velero/nightly',
      });
      expect(first[0].payload).toMatchObject({
        backup: 'nightly-1',
        reason: 'BackupStorageLocation "default" is unavailable',
      });
      expect(sent.map((n) => n.kind)).toEqual(['fired']);
      expect(sent[0]?.channelIds).toEqual([CHANNEL]);

      // Same state, later: the same event, nothing said again.
      expect(await engine.evaluateOrg(orgId, new Date(NOW.getTime() + 60_000))).toMatchObject({
        fired: 0,
        resolved: 0,
      });
      expect(await events(call, orgId)).toHaveLength(1);
      expect(sent).toHaveLength(1);

      // A newer failure of the same schedule is the same condition, with the newer backup named.
      await backup(orgId, clusterId, 'nightly-2', 'Failed', 1, {
        labels: { 'velero.io/schedule-name': 'nightly' },
      });
      await engine.evaluateOrg(orgId, NOW);
      const updated = await events(call, orgId);
      expect(updated).toHaveLength(1);
      expect(updated[0].payload.backup).toBe('nightly-2');

      // Fixed.
      await backup(orgId, clusterId, 'nightly-3', 'Completed', 0.5, {
        labels: { 'velero.io/schedule-name': 'nightly' },
      });
      expect(await engine.evaluateOrg(orgId, NOW)).toMatchObject({ fired: 0, resolved: 1 });
      const done = await events(call, orgId);
      expect(done[0]).toMatchObject({ state: 'RESOLVED' });
      expect(done[0].resolvedAt).not.toBeNull();
      expect(sent.map((n) => n.kind)).toEqual(['fired', 'resolved']);

      // And it stays resolved; a new failure after that is a new event.
      await engine.evaluateOrg(orgId, NOW);
      expect(await events(call, orgId)).toHaveLength(1);
      await backup(orgId, clusterId, 'nightly-4', 'PartiallyFailed', 0.1, {
        labels: { 'velero.io/schedule-name': 'nightly' },
      });
      await engine.evaluateOrg(orgId, NOW);
      const again = await events(call, orgId);
      expect(again.map((e) => e.state).sort()).toEqual(['FIRING', 'RESOLVED']);
      expect(await events(call, orgId, '?state=FIRING')).toHaveLength(1);
    });

    it('is not announced as resolved to people who were never told', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, { channelIds: [] }).expect(201);
      await backup(orgId, clusterId, 'b1', 'Failed', 1, {
        labels: { 'velero.io/schedule-name': 's' },
      });
      await engine.evaluateOrg(orgId, NOW);
      await backup(orgId, clusterId, 'b2', 'Completed', 0.5, {
        labels: { 'velero.io/schedule-name': 's' },
      });
      await engine.evaluateOrg(orgId, NOW);
      expect((await events(call, orgId))[0].state).toBe('RESOLVED');
      expect(sent).toEqual([]);
    });
  });

  describe('a condition nobody was told about', () => {
    it('is not announced as resolved either, when the channel never took the first message', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, {}).expect(201);
      await backup(orgId, clusterId, 'b1', 'Failed', 1, {
        labels: { 'velero.io/schedule-name': 's' },
      });
      fail = true;
      await engine.evaluateOrg(orgId, NOW);
      await backup(orgId, clusterId, 'b2', 'Completed', 0.5, {
        labels: { 'velero.io/schedule-name': 's' },
      });
      fail = false;
      await engine.evaluateOrg(orgId, NOW);
      expect((await events(call, orgId))[0].state).toBe('RESOLVED');
      expect(sent).toEqual([]);
    });
  });

  describe('repeating, retrying and closing', () => {
    async function firing(params: object = {}) {
      const o = await org();
      const created = (await rule(o.call, o.orgId, { params }).expect(201)).body;
      await backup(o.orgId, o.clusterId, 'b1', 'Failed', 1);
      await engine.evaluateOrg(o.orgId, NOW);
      sent.length = 0;
      return { ...o, ruleId: created.id as string };
    }
    const later = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

    it('repeats a condition that stays, once per interval', async () => {
      const { orgId } = await firing({ renotifyMinutes: 60, lookbackHours: 100 });
      await engine.evaluateOrg(orgId, later(59));
      expect(sent).toEqual([]);
      expect(await engine.evaluateOrg(orgId, later(61))).toMatchObject({ renotified: 1 });
      expect(sent.map((n) => n.kind)).toEqual(['renotify']);
      await engine.evaluateOrg(orgId, later(100));
      expect(sent).toHaveLength(1);
      await engine.evaluateOrg(orgId, later(122));
      expect(sent).toHaveLength(2);
    });

    it('never repeats when the interval is 0', async () => {
      const { orgId } = await firing({ renotifyMinutes: 0, lookbackHours: 720 });
      await engine.evaluateOrg(orgId, later(60));
      await engine.evaluateOrg(orgId, later(4000));
      expect(sent).toEqual([]);
    });

    it('offers the notification again when the notifier could not take it', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, {}).expect(201);
      await backup(orgId, clusterId, 'b1', 'Failed', 1);
      fail = true;
      await engine.evaluateOrg(orgId, NOW);
      const stuck = await events(call, orgId);
      expect(stuck).toHaveLength(1);
      expect(stuck[0].lastNotifiedAt).toBeNull();
      expect(sent).toEqual([]);
      fail = false;
      await engine.evaluateOrg(orgId, later(1));
      expect(sent.map((n) => n.kind)).toEqual(['fired']);
      expect((await events(call, orgId))[0].lastNotifiedAt).not.toBeNull();
    });

    it('tells a channel added later about a condition already open', async () => {
      const { call, orgId, clusterId } = await org();
      const created = (await rule(call, orgId, { channelIds: [] }).expect(201)).body;
      await backup(orgId, clusterId, 'b1', 'Failed', 1);
      await engine.evaluateOrg(orgId, NOW);
      expect(sent).toEqual([]);
      await call('patch', `/orgs/${orgId}/alerts/rules/${created.id}`, {
        channelIds: [CHANNEL],
      }).expect(200);
      await engine.evaluateOrg(orgId, later(1));
      expect(sent.map((n) => n.kind)).toEqual(['fired']);
    });

    it('closes the open events of a rule that is switched off, without a message', async () => {
      const { call, orgId, ruleId } = await firing();
      await call('patch', `/orgs/${orgId}/alerts/rules/${ruleId}`, { enabled: false }).expect(200);
      expect(await engine.evaluateAll(later(1))).toMatchObject({ resolved: 1 });
      expect((await events(call, orgId))[0].state).toBe('RESOLVED');
      expect(sent).toEqual([]);
    });

    it('closes the open events of a cluster the rule no longer covers', async () => {
      const { call, orgId, ruleId } = await firing();
      const other = (await call('post', `/orgs/${orgId}/clusters`, { name: 'dev' }).expect(201))
        .body.cluster.id;
      await call('patch', `/orgs/${orgId}/alerts/rules/${ruleId}`, {
        scope: { clusterIds: [other] },
      }).expect(200);
      await engine.evaluateOrg(orgId, later(1));
      expect((await events(call, orgId))[0].state).toBe('RESOLVED');
      expect(sent).toEqual([]);
    });

    it('takes a rule’s history with it when the rule is deleted', async () => {
      const { call, orgId, ruleId } = await firing();
      await call('delete', `/orgs/${orgId}/alerts/rules/${ruleId}`).expect(204);
      expect(await events(call, orgId)).toEqual([]);
    });

    it('cannot be duplicated by two evaluations at once', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, {}).expect(201);
      await backup(orgId, clusterId, 'b1', 'Failed', 1);
      const runs = await Promise.all(
        Array.from({ length: 6 }, () => engine.evaluateOrg(orgId, NOW)),
      );
      expect(runs.reduce((n, r) => n + r.fired, 0)).toBe(1);
      expect(await events(call, orgId)).toHaveLength(1);
      expect(sent).toHaveLength(1);
    });
  });

  describe('the other rule types', () => {
    it('agent disconnected: fires after the time given and resolves on reconnect', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, { type: 'AGENT_DISCONNECTED', params: { minutes: 10 } }).expect(201);
      const set = (status: string, minutesAgo: number) =>
        h.prisma.inOrg(orgId, () =>
          h.prisma.cluster.update({
            where: { id: clusterId },
            data: {
              status: status as any,
              lastSeenAt: new Date(NOW.getTime() - minutesAgo * 60_000),
            },
          }),
        );
      await set('DISCONNECTED', 5);
      await engine.evaluateOrg(orgId, NOW);
      expect(await events(call, orgId)).toEqual([]);
      await set('DISCONNECTED', 15);
      await engine.evaluateOrg(orgId, NOW);
      expect((await events(call, orgId))[0]).toMatchObject({
        state: 'FIRING',
        fingerprint: 'agent-disconnected',
      });
      await set('CONNECTED', 0);
      await engine.evaluateOrg(orgId, NOW);
      expect((await events(call, orgId))[0].state).toBe('RESOLVED');
      expect(sent.map((n) => n.kind)).toEqual(['fired', 'resolved']);
    });

    it('storage location unavailable: fires per location and resolves when it recovers', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, { type: 'BSL_UNAVAILABLE' }).expect(201);
      await seed(orgId, clusterId, 'BACKUP_STORAGE_LOCATION', 'default', { phase: 'Unavailable' });
      await seed(orgId, clusterId, 'BACKUP_STORAGE_LOCATION', 'second', { phase: 'Available' });
      await engine.evaluateOrg(orgId, NOW);
      const open = await events(call, orgId);
      expect(open.map((e) => e.fingerprint)).toEqual(['bsl-unavailable:velero/default']);
      await h.prisma.inOrg(orgId, () =>
        h.prisma.veleroResource.updateMany({
          where: { name: 'default' },
          data: { phase: 'Available' },
        }),
      );
      await engine.evaluateOrg(orgId, NOW);
      expect((await events(call, orgId))[0].state).toBe('RESOLVED');
    });

    it('schedule missed: fires when a schedule is late and resolves when a backup appears', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, { type: 'SCHEDULE_MISSED' }).expect(201);
      await seed(orgId, clusterId, 'SCHEDULE', 'nightly', {
        phase: 'Enabled',
        spec: { schedule: '0 2 * * *' },
        creationTimestamp: at(24 * 10),
      });
      await engine.evaluateOrg(orgId, NOW);
      expect((await events(call, orgId))[0]).toMatchObject({
        state: 'FIRING',
        fingerprint: 'schedule-missed:velero/nightly',
      });
      await backup(orgId, clusterId, 'nightly-x', 'Completed', 1, {
        labels: { 'velero.io/schedule-name': 'nightly' },
      });
      await engine.evaluateOrg(orgId, NOW);
      expect((await events(call, orgId))[0].state).toBe('RESOLVED');
    });

    it('schedule missed: a paused schedule is left alone', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, { type: 'SCHEDULE_MISSED' }).expect(201);
      await seed(orgId, clusterId, 'SCHEDULE', 'nightly', {
        spec: { schedule: '0 2 * * *', paused: true },
        creationTimestamp: at(24 * 10),
      });
      await engine.evaluateOrg(orgId, NOW);
      expect(await events(call, orgId)).toEqual([]);
    });

    it('backup expiring: fires with no newer backup and resolves when one is taken', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, { type: 'BACKUP_EXPIRING', params: { withinDays: 3 } }).expect(201);
      await backup(orgId, clusterId, 'old', 'Completed', 48, {
        labels: { 'velero.io/schedule-name': 's' },
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      });
      await engine.evaluateOrg(orgId, NOW);
      expect((await events(call, orgId))[0]).toMatchObject({
        state: 'FIRING',
        fingerprint: 'backup-expiring:velero/s',
      });
      await backup(orgId, clusterId, 'new', 'Completed', 1, {
        labels: { 'velero.io/schedule-name': 's' },
        expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      });
      await engine.evaluateOrg(orgId, NOW);
      expect((await events(call, orgId))[0].state).toBe('RESOLVED');
    });
  });

  describe('scope and isolation', () => {
    it('a rule scoped to one cluster ignores another', async () => {
      const a = await org();
      const second = (
        await a.call('post', `/orgs/${a.orgId}/clusters`, { name: 'dev' }).expect(201)
      ).body.cluster.id;
      await rule(a.call, a.orgId, { scope: { clusterIds: [second] } }).expect(201);
      await backup(a.orgId, a.clusterId, 'b1', 'Failed', 1);
      await engine.evaluateOrg(a.orgId, NOW);
      expect(await events(a.call, a.orgId)).toEqual([]);
      await backup(a.orgId, second, 'b2', 'Failed', 1);
      await engine.evaluateOrg(a.orgId, NOW);
      expect((await events(a.call, a.orgId)).map((e) => e.clusterName)).toEqual(['dev']);
    });

    it('one org’s failures never fire another org’s rules', async () => {
      const a = await org();
      await rule(a.call, a.orgId, {}).expect(201);
      const other = await h.prisma.organization.create({
        data: { id: newId(), name: 'B', slug: 'b' } as any,
      });
      const theirs = await h.prisma.inOrg(other.id, () =>
        h.prisma.cluster.create({ data: { id: newId(), orgId: other.id, name: 'theirs' } as any }),
      );
      await backup(other.id, theirs.id, 'b1', 'Failed', 1);
      const summary = await engine.evaluateAll(NOW);
      expect(summary.fired).toBe(0);
      expect(await events(a.call, a.orgId)).toEqual([]);
    });

    it('evaluates every org that has a rule in one pass', async () => {
      const a = await org();
      await rule(a.call, a.orgId, {}).expect(201);
      await backup(a.orgId, a.clusterId, 'b1', 'Failed', 1);
      expect(await engine.evaluateAll(NOW)).toMatchObject({ orgs: 1, fired: 1 });
    });

    it('pages the history newest first', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, {}).expect(201);
      for (const n of ['a', 'b', 'c']) {
        await backup(orgId, clusterId, `x-${n}`, 'Failed', 1);
      }
      await engine.evaluateOrg(orgId, NOW);
      const page = await call('get', `/orgs/${orgId}/alerts/events?limit=2`).expect(200);
      expect(page.body.events).toHaveLength(2);
      expect(page.body.nextCursor).not.toBeNull();
      const rest = await call(
        'get',
        `/orgs/${orgId}/alerts/events?limit=2&cursor=${page.body.nextCursor}`,
      ).expect(200);
      expect(rest.body.events).toHaveLength(1);
      expect(rest.body.nextCursor).toBeNull();
      await call('get', `/orgs/${orgId}/alerts/events?limit=0`).expect(422);
    });
  });

  describe('the timer', () => {
    it('lets one replica evaluate per interval', async () => {
      const evaluator = h.app.get(AlertEvaluator);
      await h.redis.connection.del('vfm:alerts:evaluator');
      expect(await evaluator.tick(NOW)).toBe(true);
      expect(await evaluator.tick(NOW)).toBe(false);
      await h.redis.connection.del('vfm:alerts:evaluator');
    });

    it('keeps going when the notifier throws', async () => {
      const { call, orgId, clusterId } = await org();
      await rule(call, orgId, {}).expect(201);
      await backup(orgId, clusterId, 'b1', 'Failed', 1);
      fail = true;
      await h.redis.connection.del('vfm:alerts:evaluator');
      expect(await h.app.get(AlertEvaluator).tick(NOW)).toBe(true);
      await h.redis.connection.del('vfm:alerts:evaluator');
    });
  });
});
