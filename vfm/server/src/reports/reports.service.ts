import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { longestGapSeconds, parseCron } from '@vfm/shared';

import { ClustersService } from '../clusters/clusters.service';
import { coverageOf } from '../inventory/coverage';
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

  async successRate(
    orgId: string,
    userId: string,
    q: { from: Date; to: Date; bucket: Bucket; clusterId?: string | undefined },
  ): Promise<SuccessRateReport> {
    const clusters = await this.scope(orgId, userId, q.clusterId);
    let incomplete = false;
    const out: ClusterSeries[] = [];
    for (const cluster of clusters) {
      const visibility = await this.rbac.visibility(orgId, userId, cluster.id, 'backup:read');
      // Deleted backups stay in: that a backup once failed is not undone by its expiry.
      const rows = await this.prisma.inOrg(orgId, () =>
        this.prisma.veleroResource.findMany({
          where: {
            clusterId: cluster.id,
            kind: 'BACKUP',
            completedAt: { gte: q.from, lt: q.to },
          },
          orderBy: { completedAt: 'desc' },
          take: ROW_CAP,
          select: { phase: true, completedAt: true, ...(visibility.all ? {} : { spec: true }) },
        }),
      );
      if (rows.length === ROW_CAP) incomplete = true;
      const seen = rows.filter(
        (r) =>
          r.completedAt !== null &&
          (visibility.all || visibility.sees(coveredBy('BACKUP', (r as { spec?: unknown }).spec))),
      );
      const points = successRate(
        seen.map((r) => ({ clusterId: cluster.id, phase: r.phase, at: r.completedAt as Date })),
        q.from,
        q.to,
        q.bucket,
      );
      out.push({
        clusterId: cluster.id,
        clusterName: cluster.name,
        points,
        totals: totals(points),
      });
    }
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

  async coverage(
    orgId: string,
    userId: string,
    q: { hours: number; clusterId?: string | undefined },
  ): Promise<CoverageReport> {
    const clusters = await this.scope(orgId, userId, q.clusterId);
    const now = new Date();
    let incomplete = false;
    const out: CoverageReport['clusters'] = [];
    for (const cluster of clusters) {
      const visibility = await this.rbac.visibility(orgId, userId, cluster.id, 'backup:read');
      const [namespaces, backups, schedules] = await this.prisma.inOrg(orgId, () =>
        Promise.all([
          this.prisma.veleroResource.findMany({
            where: { clusterId: cluster.id, kind: 'NAMESPACE', deletedAt: null },
            select: { name: true },
            take: 10_000,
          }),
          // Newest first, so a limit drops the oldest, which matter least here. Deleted backups
          // cannot be restored from, so they do not cover anything.
          this.prisma.veleroResource.findMany({
            where: { clusterId: cluster.id, kind: 'BACKUP', phase: 'Completed', deletedAt: null },
            orderBy: { completedAt: { sort: 'desc', nulls: 'last' } },
            take: COVERAGE_CAP,
            select: { name: true, spec: true, completedAt: true },
          }),
          this.prisma.veleroResource.findMany({
            where: { clusterId: cluster.id, kind: 'SCHEDULE', deletedAt: null },
            take: 500,
            select: { spec: true },
          }),
        ]),
      );
      if (backups.length === COVERAGE_CAP) incomplete = true;
      const shown = namespaces
        .map((n) => n.name)
        .filter(
          (name) =>
            visibility.all || visibility.sees({ namespaces: [name], includesClusterScoped: false }),
        );
      const rows = shown.map((namespace) => {
        const c = coverageOf(namespace, backups, schedules, now);
        return { namespace, lastBackupAt: c.lastBackupAt, scheduled: c.scheduled };
      });
      out.push({
        clusterId: cluster.id,
        clusterName: cluster.name,
        namespaces: staleNamespaces(rows, q.hours, now),
        total: rows.length,
      });
    }
    return { hours: q.hours, generatedAt: now.toISOString(), clusters: out, incomplete };
  }

  async rpo(
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
    let incomplete = false;
    const rows: RpoRow[] = [];
    for (const cluster of clusters) {
      const visibility = await this.rbac.visibility(orgId, userId, cluster.id, 'schedule:read');
      const schedules = await this.prisma.inOrg(orgId, () =>
        this.prisma.veleroResource.findMany({
          where: { clusterId: cluster.id, kind: 'SCHEDULE', deletedAt: null },
          take: 500,
          select: { name: true, namespace: true, spec: true, creationTimestamp: true },
        }),
      );
      const mine = schedules.filter(
        (s) => visibility.all || visibility.sees(coveredBy('SCHEDULE', s.spec)),
      );
      if (mine.length === 0) continue;
      // One read for the cluster's successful backups that belong to a schedule.
      const backups = await this.prisma.inOrg(orgId, () =>
        this.prisma.veleroResource.findMany({
          where: {
            clusterId: cluster.id,
            kind: 'BACKUP',
            phase: 'Completed',
            completedAt: { gte: new Date(q.from.getTime() - 366 * DAY), lte: q.to },
          },
          orderBy: { completedAt: 'desc' },
          take: ROW_CAP,
          select: { namespace: true, labels: true, completedAt: true },
        }),
      );
      if (backups.length === ROW_CAP) incomplete = true;
      for (const s of mine) {
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
        const successes = backups
          .filter(
            (b) =>
              b.namespace === s.namespace &&
              isRecord(b.labels) &&
              b.labels['velero.io/schedule-name'] === s.name &&
              b.completedAt !== null,
          )
          .map((b) => b.completedAt as Date);
        rows.push({
          clusterId: cluster.id,
          clusterName: cluster.name,
          schedule: s.name,
          cron,
          targetHours,
          ...rpoCompliance(successes, q.from, q.to, targetHours * HOUR, s.creationTimestamp),
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
