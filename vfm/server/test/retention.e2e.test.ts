/* eslint-disable @typescript-eslint/no-explicit-any -- seeding rows the API cannot create */
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env.schema';
import { newId } from '../src/common/uuid';
import { RetentionService } from '../src/retention/retention.service';
import { createTestApp, type TestApp } from './app-harness';
import { World, type Call } from './world';

/**
 * M6 / R-101: the daily retention job against real PostgreSQL. Every number below is a boundary the
 * plan states (events 1 h, commands 180 days, audit 400 days by default) or one this code chose
 * (soft-deleted objects 7 days, deleted backups 400 days so the 366-day reports still see them).
 */
const DAY = 86_400_000;
const NOW = new Date('2026-10-20T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('retention (e2e)', () => {
  let h: TestApp;
  let world: World;
  let exportDir: string;
  // The append-only audit table is never truncated between runs, so each test tags its own rows.
  let tag = '';

  beforeAll(async () => {
    exportDir = mkdtempSync(join(tmpdir(), 'vfm-audit-export-'));
    process.env.AUDIT_EXPORT_DIR = exportDir;
    h = await createTestApp();
    world = new World(h);
    await world.init();
  }, 60_000);

  afterAll(async () => {
    delete process.env.AUDIT_EXPORT_DIR;
    world.close();
    await h.close();
  });

  beforeEach(async () => {
    await h.reset();
    tag = randomUUID().slice(0, 8);
  });

  const retention = (): RetentionService => h.app.get(RetentionService);

  async function twoOrgs() {
    const { call, orgId, userId } = await world.admin();
    const second = (await call('post', '/orgs', { name: 'Second', slug: 'second' }).expect(201))
      .body.id as string;
    const cluster = async (org: string, name: string): Promise<string> => {
      await call('post', '/me/active-org', { orgId: org }).expect(204);
      return (await call('post', `/orgs/${org}/clusters`, { name }).expect(201)).body.cluster
        .id as string;
    };
    return {
      call,
      userId,
      a: orgId,
      b: second,
      clusterA: await cluster(orgId, 'a1'),
      clusterB: await cluster(second, 'b1'),
    };
  }

  const resource = (
    orgId: string,
    clusterId: string,
    kind: string,
    name: string,
    over: Record<string, unknown> = {},
  ) =>
    h.prisma.inOrg(orgId, () =>
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
  const names = async (orgId: string, kind: string): Promise<string[]> =>
    (
      await h.prisma.inOrg(orgId, () =>
        h.prisma.veleroResource.findMany({
          where: { kind },
          select: { name: true },
          orderBy: { name: 'asc' },
        }),
      )
    ).map((r) => r.name);
  const audit = (orgId: string | null, action: string, at: Date) =>
    h.prisma.unscoped('test', () =>
      h.prisma.auditEvent.create({
        data: {
          id: newId(),
          orgId,
          actorType: 'SYSTEM',
          action: `rt.${tag}.${action}`,
          outcome: 'SUCCESS',
          createdAt: at,
        },
      }),
    );
  const auditActions = async (orgId: string | null): Promise<string[]> =>
    (
      await h.prisma.unscoped('test', () =>
        h.prisma.auditEvent.findMany({
          where: { orgId, action: { startsWith: `rt.${tag}.` } },
          select: { action: true },
          orderBy: { action: 'asc' },
        }),
      )
    ).map((r) => r.action.slice(`rt.${tag}.`.length));
  const setOrg = (call: Call, orgId: string, settings: object) =>
    call('patch', `/orgs/${orgId}`, settings).expect(200);

  it('removes events past their hour, finished commands past 180 days and expired files, and keeps the rest', async () => {
    const { a, clusterA } = await twoOrgs();
    await resource(a, clusterA, 'EVENT', 'old-event', { updatedAt: ago(2 * 3_600_000) });
    await resource(a, clusterA, 'EVENT', 'fresh-event', { updatedAt: ago(10 * 60_000) });

    const command = (status: string, ageDays: number) =>
      h.prisma.inOrg(a, () =>
        h.prisma.command.create({
          data: {
            id: newId(),
            orgId: a,
            clusterId: clusterA,
            op: 'CREATE_BACKUP',
            payload: {},
            status,
            deadlineAt: ago(ageDays * DAY),
            createdAt: ago(ageDays * DAY),
          } as any,
        }),
      );
    const oldDone = await command('SUCCEEDED', 200);
    const recentDone = await command('SUCCEEDED', 10);
    const oldStuck = await command('SENT', 200);
    const file = (name: string, expiresAt: Date) =>
      h.prisma.inOrg(a, () =>
        h.prisma.veleroFile.create({
          data: {
            id: newId(),
            orgId: a,
            clusterId: clusterA,
            part: 'BACKUP_LOG',
            targetName: name,
            targetUid: randomUUID(),
            content: Buffer.from('x'),
            sizeBytes: 1,
            sha256: 'x',
            expiresAt,
          } as any,
        }),
      );
    await file('expired', ago(DAY));
    await file('live', new Date(NOW.getTime() + DAY));

    const report = await retention().run(NOW);

    expect(report).toMatchObject({ events: 1, commands: 1, files: 1, partial: false });
    expect(await names(a, 'EVENT')).toEqual(['fresh-event']);
    const left = await h.prisma.inOrg(a, () => h.prisma.command.findMany({ select: { id: true } }));
    expect(left.map((c) => c.id).sort()).toEqual([recentDone.id, oldStuck.id].sort());
    expect(left.map((c) => c.id)).not.toContain(oldDone.id);
    // An unfinished command is still work, however old.
    expect(
      (
        await h.prisma.inOrg(a, () =>
          h.prisma.veleroFile.findMany({ select: { targetName: true } }),
        )
      ).map((f) => f.targetName),
    ).toEqual(['live']);
  });

  it('keeps deleted backups long enough for the reports, and forgets other deleted objects sooner', async () => {
    const { a, clusterA } = await twoOrgs();
    await resource(a, clusterA, 'BACKUP', 'deleted-200d', { deletedAt: ago(200 * DAY) });
    await resource(a, clusterA, 'BACKUP', 'deleted-500d', { deletedAt: ago(500 * DAY) });
    await resource(a, clusterA, 'POD', 'pod-10d', { deletedAt: ago(10 * DAY) });
    await resource(a, clusterA, 'POD', 'pod-2d', { deletedAt: ago(2 * DAY) });
    await resource(a, clusterA, 'BACKUP', 'live');

    const report = await retention().run(NOW);

    expect(report.softDeleted).toBe(2);
    expect(await names(a, 'BACKUP')).toEqual(['deleted-200d', 'live']);
    expect(await names(a, 'POD')).toEqual(['pod-2d']);
  });

  it('purges audit events by each organization’s own setting, and never across organizations', async () => {
    const { a, b, call } = await twoOrgs();
    await audit(a, 'a.old', ago(500 * DAY));
    await audit(a, 'a.recent', ago(100 * DAY));
    await audit(b, 'b.old', ago(500 * DAY));
    await audit(b, 'b.recent', ago(100 * DAY));
    await audit(null, 'none.old', ago(500 * DAY));
    await audit(null, 'none.recent', ago(5 * DAY));
    // Organization B keeps 30 days only.
    await setOrg(call, b, { auditRetentionDays: 30 });

    const report = await retention().run(NOW);

    expect(await auditActions(a)).toEqual(['a.recent']); // the 400-day default
    expect(await auditActions(b)).toEqual([]); // 30 days: both are older
    expect(await auditActions(null)).toEqual(['none.recent']);
    expect(report.audit.reduce((n, x) => n + x.deleted, 0)).toBeGreaterThanOrEqual(4);
  });

  it('writes the events to a file first when the organization asks, and the file holds exactly what was deleted', async () => {
    const { b, call } = await twoOrgs();
    await audit(b, 'export.1', ago(60 * DAY));
    await audit(b, 'export.2', ago(50 * DAY));
    await audit(b, 'export.keep', ago(5 * DAY));
    await setOrg(call, b, { auditRetentionDays: 30, auditExportBeforeDelete: true });

    const report = await retention().run(NOW);

    const mine = report.audit.find((x) => x.orgId === b);
    expect(mine?.exportedTo).toBeDefined();
    const csv = readFileSync(mine?.exportedTo ?? '', 'utf8');
    expect(csv).toContain('export.1');
    expect(csv).toContain('export.2');
    expect(csv).not.toContain('export.keep');
    expect(csv.split('\r\n')[0]).toContain('action');
    expect(await auditActions(b)).toEqual(['export.keep']);
    // No half-written file is left behind.
    expect(readdirSync(exportDir).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  it('deletes nothing for an organization that wants an export it cannot have', async () => {
    const { b, call } = await twoOrgs();
    await audit(b, 'unexported', ago(60 * DAY));
    await setOrg(call, b, { auditRetentionDays: 30, auditExportBeforeDelete: true });
    const env = h.app.get<Env>(ENV);
    const before = env.AUDIT_EXPORT_DIR;
    env.AUDIT_EXPORT_DIR = undefined;
    try {
      const report = await retention().run(NOW);
      expect(report.partial).toBe(true);
      expect(report.audit.find((x) => x.orgId === b)?.skipped).toMatch(/export/);
    } finally {
      env.AUDIT_EXPORT_DIR = before;
    }
    expect(await auditActions(b)).toEqual(['unexported']);
  });

  it('can be run again and again: the second run finds nothing', async () => {
    const { a, clusterA } = await twoOrgs();
    await resource(a, clusterA, 'EVENT', 'old-event', { updatedAt: ago(2 * 3_600_000) });
    await audit(a, 'once', ago(500 * DAY));
    const first = await retention().run(NOW);
    const second = await retention().run(NOW);
    expect(first.events).toBe(1);
    expect(first.audit.reduce((n, x) => n + x.deleted, 0)).toBeGreaterThanOrEqual(1);
    expect(second).toMatchObject({
      events: 0,
      softDeleted: 0,
      files: 0,
      commands: 0,
      partial: false,
    });
    expect(second.audit.reduce((n, x) => n + x.deleted, 0)).toBe(0);
  });

  it('is taken by one replica per interval', async () => {
    {
      const env = h.app.get<Env>(ENV);
      const before = env.RETENTION_INTERVAL_HOURS;
      env.RETENTION_INTERVAL_HOURS = 24;
      try {
        await h.redis.connection.del('vfm:retention:lock');
        expect(await retention().runIfDue()).toBeDefined();
        expect(await retention().runIfDue()).toBeUndefined();
      } finally {
        env.RETENTION_INTERVAL_HOURS = before;
        await h.redis.connection.del('vfm:retention:lock');
      }
    }
  });

  it('refuses to change the audit trail in any other way: UPDATE is still refused for the application', async () => {
    const { a } = await twoOrgs();
    const e = await audit(a, 'immutable', ago(DAY));
    await expect(
      h.prisma.unscoped('test', () =>
        h.prisma.auditEvent.update({ where: { id: e.id }, data: { action: 'changed' } }),
      ),
    ).rejects.toThrow(/append-only/);
  });
});
