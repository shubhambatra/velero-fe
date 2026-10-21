import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { longestGapSeconds, parseCron } from '@vfm/shared';

import { ClustersService } from '../clusters/clusters.service';
import { coverageOfMany } from '../inventory/coverage';
import { coveredBy } from '../inventory/projections';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import {
  rpoCompliance,
  staleNamespaces,
  successRate,
  sumSeries,
  totals,
  type Bucket,
  type RatePoint,
  type RpoResult,
  type StaleNamespace,
} from './calculations';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Rows read per cluster and per question; past it the answer says it is incomplete rather than quietly short. */
export const ROW_CAP = 100_000;
export const COVERAGE_CAP = 20_000;

/** Tunable so tests, which read what they just wrote, can switch the sharing off. */
export const reportOptions = { coverageInputsCacheMs: 5_000, resultCacheMs: 30_000 };

export interface ClusterSeries {
  clusterId: string;
  clusterName: string;
  points: RatePoint[];
  totals: Omit<RatePoint, 'start'>;
}

export interface SuccessRateReport {
  from: string;
  to: string;
  bucket: Bucket;
  clusters: ClusterSeries[];
  all: { points: RatePoint[]; totals: Omit<RatePoint, 'start'> };
  /** Some cluster had more finished backups than could be read; its numbers are for the newest. */
  incomplete: boolean;
}

export interface CoverageReport {
  hours: number;
  generatedAt: string;
  clusters: {
    clusterId: string;
    clusterName: string;
    namespaces: StaleNamespace[];
    total: number;
  }[];
  incomplete: boolean;
}

export interface RpoRow extends RpoResult {
  clusterId: string;
  clusterName: string;
  schedule: string;
  cron: string | null;
  targetHours: number;
}

export interface RpoReport {
  from: string;
  to: string;
  schedules: RpoRow[];
  incomplete: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The reports (PLAN.md §11.1 page 12, §16 day 34), computed from `velero_resources`.
 *
 * Each question reads narrow columns through the org-scoped Prisma client and aggregates
 * here, rather than in raw SQL: the org scope and the namespace visibility of PLAN.md §8.2
 * both depend on that client, and raw SQL is allowed nowhere that touches tenant data
 * (`prisma/org-scope.test.ts`). The arithmetic is in `calculations.ts`.
 *
 * What a caller sees follows what they may read: only clusters they can read, and on each
 * only the backups, schedules and namespaces their bindings reach. A person scoped to some
 * namespaces gets the rate of *their* backups, never a number computed over ones they cannot see.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clusters: ClustersService,
    private readonly rbac: RbacService,
  ) {}

  /** Clusters the caller may read backups on, optionally narrowed to one (404 when that one is not theirs). */
  private async scope(orgId: string, userId: string, clusterId: string | undefined) {
    const visible = await this.clusters.list(orgId, userId);
    const held = await this.rbac.matrix(
      orgId,
      userId,
      visible.map((c) => c.id),
      ['backup:read', 'schedule:read'],
    );
    const usable = visible.filter((c) => (held.get(c.id)?.size ?? 0) > 0);
    if (clusterId === undefined) {
      return usable;
    }
    const one = usable.find((c) => c.id === clusterId);
    if (one === undefined) {
      throw new NotFoundException('cluster not found');
    }
    return [one];
  }

  private readonly resultCache = new Map<string, { at: number; value: Promise<unknown> }>();

  /**
   * A report is a minutes-old summary by nature (it says when it was generated), and computing one
   * reads tens of thousands of rows: at 100 people on the page it was most of the control plane's
   * CPU. So an answer is shared, single-flight, for `resultCacheMs`. What a person may see decides
   * the key: people who see every namespace of the same clusters share one answer; anyone narrower
   * gets their own, so a filtered number is never served to someone else. Time bounds are keyed to
   * the minute because the defaults are "now".
   */
  private async shared<T>(
    orgId: string,
    userId: string,
    name: string,
    permission: 'backup:read' | 'schedule:read',
    clusterId: string | undefined,
    params: Record<string, unknown>,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (reportOptions.resultCacheMs <= 0) {
      return compute();
    }
    const clusters = await this.scope(orgId, userId, clusterId);
    const ids = clusters.map((c) => c.id);
    const visibility = await this.rbac.visibilities(orgId, userId, ids, permission);
    const everything = [...visibility.values()].every((v) => v.all);
    const bounds = (v: unknown): unknown =>
      v instanceof Date ? Math.floor(v.getTime() / 60_000) : v;
    const key = JSON.stringify([
      orgId,
      name,
      everything ? 'all' : userId,
      ids,
      Object.entries(params).map(([k, v]) => [k, bounds(v)]),
    ]);
    const held = this.resultCache.get(key);
    if (held !== undefined && Date.now() - held.at < reportOptions.resultCacheMs) {
      return held.value as Promise<T>;
    }
    const value = compute();
    this.resultCache.set(key, { at: Date.now(), value });
    if (this.resultCache.size > 500) this.resultCache.clear();
    value.catch(() => {
      if (this.resultCache.get(key)?.value === value) this.resultCache.delete(key);
    });
    return value;
  }

  successRate(
    orgId: string,
    userId: string,
    q: { from: Date; to: Date; bucket: Bucket; clusterId?: string | undefined },
  ): Promise<SuccessRateReport> {
    return this.shared(orgId, userId, 'success-rate', 'backup:read', q.clusterId, { ...q }, () =>
      this.computeSuccessRate(orgId, userId, q),
    );
  }

  coverage(
    orgId: string,
    userId: string,
    q: { hours: number; clusterId?: string | undefined },
  ): Promise<CoverageReport> {
    return this.shared(orgId, userId, 'coverage', 'backup:read', q.clusterId, { ...q }, () =>
      this.computeCoverage(orgId, userId, q),
    );
  }

  rpo(
    orgId: string,
    userId: string,
    q: {
      from: Date;
      to: Date;
      factor: number;
      targetHours?: number | undefined;
      clusterId?: string | undefined;
    },
  ): Promise<RpoReport> {
    return this.shared(orgId, userId, 'rpo', 'schedule:read', q.clusterId, { ...q }, () =>
      this.computeRpo(orgId, userId, q),
    );
  }

  /**
   * Success rate. Every cluster is read in one query (not one per cluster: at 200 clusters a page
   * was 200 round trips and 800 permission lookups), and the rows are sorted into clusters here.
   */
  private async computeSuccessRate(
    orgId: string,
    userId: string,
    q: { from: Date; to: Date; bucket: Bucket; clusterId?: string | undefined },
  ): Promise<SuccessRateReport> {
    const clusters = await this.scope(orgId, userId, q.clusterId);
    const visibility = await this.rbac.visibilities(
      orgId,
      userId,
      clusters.map((c) => c.id),
      'backup:read',
    );
    // The spec is read only when someone may see just part of a cluster, which needs it.
    const needSpec = [...visibility.values()].some((v) => !v.all);
    // Deleted backups stay in: that a backup once failed is not undone by its expiry.
    const rows =
      clusters.length === 0
        ? []
        : await this.prisma.inOrg(orgId, () =>
            this.prisma.veleroResource.findMany({
              where: {
                clusterId: { in: clusters.map((c) => c.id) },
                kind: 'BACKUP',
                completedAt: { gte: q.from, lt: q.to },
              },
              orderBy: { completedAt: 'desc' },
              take: ROW_CAP * 2,
              select: {
                clusterId: true,
                phase: true,
                completedAt: true,
                ...(needSpec ? { spec: true } : {}),
              },
            }),
          );
    const incomplete = rows.length === ROW_CAP * 2;
    const byCluster = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byCluster.get(row.clusterId) ?? [];
      list.push(row);
      byCluster.set(row.clusterId, list);
    }
    const out: ClusterSeries[] = clusters.map((cluster) => {
      const v = visibility.get(cluster.id);
      const seen = (byCluster.get(cluster.id) ?? []).filter(
        (r) =>
          r.completedAt !== null &&
          v !== undefined &&
          (v.all || v.sees(coveredBy('BACKUP', (r as { spec?: unknown }).spec))),
      );
      const points = successRate(
        seen.map((r) => ({ clusterId: cluster.id, phase: r.phase, at: r.completedAt as Date })),
        q.from,
        q.to,
        q.bucket,
      );
      return { clusterId: cluster.id, clusterName: cluster.name, points, totals: totals(points) };
    });
    const all = sumSeries(out.map((c) => c.points));
    return {
      from: q.from.toISOString(),
      to: q.to.toISOString(),
      bucket: q.bucket,
      clusters: out,
      all: { points: all, totals: totals(all) },
      incomplete,
    };
  }

  private readonly coverageCache = new Map<
    string,
    { at: number; value: ReturnType<ReportsService['readCoverageInputs']> }
  >();

  /**
   * The three reads behind the coverage report are the same for everyone who may read the same
   * clusters; what differs per person (which namespaces they see) is applied afterwards. Shared for
   * a few seconds and single-flight, so a hundred people on the page cost one read, not a hundred.
   */
  private coverageInputs(orgId: string, ids: string[], hours: number, since: Date) {
    const key = `${orgId}|${String(hours)}|${ids.join(',')}`;
    const held = this.coverageCache.get(key);
    if (held !== undefined && Date.now() - held.at < reportOptions.coverageInputsCacheMs) {
      return held.value;
    }
    const value = this.readCoverageInputs(orgId, ids, since);
    this.coverageCache.set(key, { at: Date.now(), value });
    if (this.coverageCache.size > 200) this.coverageCache.clear();
    value.catch(() => {
      if (this.coverageCache.get(key)?.value === value) this.coverageCache.delete(key);
    });
    return value;
  }

  private readCoverageInputs(orgId: string, ids: string[], since: Date) {
    return this.prisma.inOrg(orgId, () =>
      Promise.all([
        this.prisma.veleroResource.findMany({
          where: { clusterId: { in: ids }, kind: 'NAMESPACE', deletedAt: null },
          select: { clusterId: true, name: true },
          take: 200_000,
        }),
        // Deleted backups cannot be restored from, so they do not cover anything.
        this.prisma.veleroResource.findMany({
          where: {
            clusterId: { in: ids },
            kind: 'BACKUP',
            phase: 'Completed',
            deletedAt: null,
            completedAt: { gte: since },
          },
          orderBy: { completedAt: 'desc' },
          take: COVERAGE_CAP * 5,
          select: { clusterId: true, name: true, spec: true, completedAt: true },
        }),
        this.prisma.veleroResource.findMany({
          where: { clusterId: { in: ids }, kind: 'SCHEDULE', deletedAt: null },
          take: 50_000,
          select: { clusterId: true, spec: true },
        }),
      ]),
    );
  }

  /**
   * Namespaces without a recent backup. A namespace is fine if a successful backup covering it
   * finished inside the window, so the first read is only the backups of the window, for every
   * cluster at once. Older backups are read, per cluster, only for clusters that have a namespace
   * left over, to say when it was last backed up: in a healthy fleet that is none of them.
   */
  private async computeCoverage(
    orgId: string,
    userId: string,
    q: { hours: number; clusterId?: string | undefined },
  ): Promise<CoverageReport> {
    const clusters = await this.scope(orgId, userId, q.clusterId);
    const ids = clusters.map((c) => c.id);
    const now = new Date();
    const since = new Date(now.getTime() - q.hours * HOUR);
    const visibility = await this.rbac.visibilities(orgId, userId, ids, 'backup:read');
    let incomplete = false;
    if (ids.length === 0) {
      return { hours: q.hours, generatedAt: now.toISOString(), clusters: [], incomplete };
    }
    const [namespaces, recent, schedules] = await this.coverageInputs(orgId, ids, q.hours, since);
    if (recent.length === COVERAGE_CAP * 5) incomplete = true;
    const group = <T extends { clusterId: string }>(rows: T[]): Map<string, T[]> => {
      const m = new Map<string, T[]>();
      for (const r of rows) {
        const held = m.get(r.clusterId);
        if (held === undefined) m.set(r.clusterId, [r]);
        else held.push(r);
      }
      return m;
    };
    const nsBy = group(namespaces);
    const recentBy = group(recent);
    const scheduleBy = group(schedules);

    const out: CoverageReport['clusters'] = [];
    for (const cluster of clusters) {
      const v = visibility.get(cluster.id);
      const shown = (nsBy.get(cluster.id) ?? [])
        .map((n) => n.name)
        .filter(
          (name) =>
            v !== undefined &&
            (v.all || v.sees({ namespaces: [name], includesClusterScoped: false })),
        );
      const sched = scheduleBy.get(cluster.id) ?? [];
      const fresh = coverageOfMany(shown, recentBy.get(cluster.id) ?? [], sched, now);
      let rows = shown.map((namespace) => {
        const c = fresh.get(namespace);
        return {
          namespace,
          lastBackupAt: c?.lastBackupAt ?? null,
          scheduled: c?.scheduled ?? false,
        };
      });
      const left = rows.filter((r) => r.lastBackupAt === null).map((r) => r.namespace);
      if (left.length > 0) {
        // Only now are older backups needed: when were these last covered?
        const older = await this.prisma.inOrg(orgId, () =>
          this.prisma.veleroResource.findMany({
            where: {
              clusterId: cluster.id,
              kind: 'BACKUP',
              phase: 'Completed',
              deletedAt: null,
              completedAt: { lt: since },
            },
            orderBy: { completedAt: 'desc' },
            take: COVERAGE_CAP,
            select: { name: true, spec: true, completedAt: true },
          }),
        );
        if (older.length === COVERAGE_CAP) incomplete = true;
        const before = coverageOfMany(left, older, sched, now);
        rows = rows.map((r) =>
          r.lastBackupAt !== null
            ? r
            : { ...r, lastBackupAt: before.get(r.namespace)?.lastBackupAt ?? null },
        );
      }
      out.push({
        clusterId: cluster.id,
        clusterName: cluster.name,
        namespaces: staleNamespaces(rows, q.hours, now),
        total: rows.length,
      });
    }
    return { hours: q.hours, generatedAt: now.toISOString(), clusters: out, incomplete };
  }

  private async computeRpo(
    orgId: string,
    userId: string,
    q: {
      from: Date;
      to: Date;
      factor: number;
      targetHours?: number | undefined;
      clusterId?: string | undefined;
    },
  ): Promise<RpoReport> {
    const clusters = await this.scope(orgId, userId, q.clusterId);
    const ids = clusters.map((c) => c.id);
    const visibility = await this.rbac.visibilities(orgId, userId, ids, 'schedule:read');
    const rows: RpoRow[] = [];
    let incomplete = false;
    if (ids.length > 0) {
      const [schedules, backups] = await this.prisma.inOrg(orgId, () =>
        Promise.all([
          this.prisma.veleroResource.findMany({
            where: { clusterId: { in: ids }, kind: 'SCHEDULE', deletedAt: null },
            take: 50_000,
            select: {
              clusterId: true,
              name: true,
              namespace: true,
              spec: true,
              creationTimestamp: true,
            },
          }),
          this.prisma.veleroResource.findMany({
            where: {
              clusterId: { in: ids },
              kind: 'BACKUP',
              phase: 'Completed',
              completedAt: { gte: new Date(q.from.getTime() - 366 * DAY), lte: q.to },
            },
            orderBy: { completedAt: 'desc' },
            take: ROW_CAP * 2,
            select: { clusterId: true, namespace: true, labels: true, completedAt: true },
          }),
        ]),
      );
      if (backups.length === ROW_CAP * 2) incomplete = true;
      // One pass: the successful backups of each schedule, keyed by cluster, namespace and name.
      const successesOf = new Map<string, Date[]>();
      for (const b of backups) {
        const name = isRecord(b.labels) ? b.labels['velero.io/schedule-name'] : undefined;
        if (typeof name !== 'string' || b.completedAt === null) continue;
        const key = `${b.clusterId}\u0000${b.namespace}\u0000${name}`;
        const list = successesOf.get(key);
        if (list === undefined) successesOf.set(key, [b.completedAt]);
        else list.push(b.completedAt);
      }
      const nameOf = new Map(clusters.map((c) => [c.id, c.name]));
      for (const s of schedules) {
        const v = visibility.get(s.clusterId);
        if (v === undefined || !(v.all || v.sees(coveredBy('SCHEDULE', s.spec)))) continue;
        const spec = isRecord(s.spec) ? s.spec : {};
        // A paused schedule is not failing its objective; it is doing what it was told.
        if (spec.paused === true) continue;
        const cron = typeof spec.schedule === 'string' ? spec.schedule : null;
        const parsed = cron === null ? null : parseCron(cron);
        const gap =
          parsed !== null && 'cron' in parsed ? longestGapSeconds(parsed.cron, q.to) : null;
        const targetHours = q.targetHours ?? (gap === null ? null : (gap * q.factor) / 3600);
        // Without a target (an unreadable cron and none given) there is nothing to measure against.
        if (targetHours === null) continue;
        rows.push({
          clusterId: s.clusterId,
          clusterName: nameOf.get(s.clusterId) ?? '',
          schedule: s.name,
          cron,
          targetHours,
          ...rpoCompliance(
            successesOf.get(`${s.clusterId}\u0000${s.namespace}\u0000${s.name}`) ?? [],
            q.from,
            q.to,
            targetHours * HOUR,
            s.creationTimestamp,
          ),
        });
      }
    }
    rows.sort(
      (a, b) =>
        (a.compliance ?? 2) - (b.compliance ?? 2) ||
        a.clusterName.localeCompare(b.clusterName) ||
        a.schedule.localeCompare(b.schedule),
    );
    return { from: q.from.toISOString(), to: q.to.toISOString(), schedules: rows, incomplete };
  }
}

/** Parsing of the shared `from`/`to` window: defaults to the last 30 days, at most a year. */
export function window(
  from: Date | undefined,
  to: Date | undefined,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - 30 * DAY);
  if (start >= end) {
    throw new BadRequestException('from must be earlier than to');
  }
  if (end.getTime() - start.getTime() > 366 * DAY) {
    throw new BadRequestException('a report covers at most 366 days');
  }
  return { from: start, to: end };
}
