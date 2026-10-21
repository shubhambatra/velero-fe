import { Injectable, NotFoundException } from '@nestjs/common';
import type { Permission } from '@vfm/shared';

import type { ClusterView } from '../clusters/clusters.service';
import { ClustersService } from '../clusters/clusters.service';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService, type TokenLimit } from '../rbac/rbac.service';
import { KIND_NAMES, permissionForKindName } from './kinds';

const READ_PERMISSIONS: Permission[] = [
  'cluster:read',
  'backup:read',
  'restore:read',
  'schedule:read',
  'storage:read',
];

export interface FleetCluster extends ClusterView {
  /** `null` when the caller may not read backups on this cluster. */
  backups: {
    total: number;
    byPhase: Record<string, number>;
    last: { name: string; phase: string | null; completedAt: Date | null } | null;
  } | null;
  schedules: { total: number; failing: number } | null;
  storage: { available: number; unavailable: number; total: number } | null;
  syncedAt: Date | null;
}

export interface ClusterOverview {
  cluster: ClusterView;
  inventory: {
    snapshotId: string | null;
    syncedAt: Date | null;
    kinds: Record<string, { total: number; byPhase: Record<string, number> }>;
  };
  locations:
    | {
        name: string;
        provider: string | null;
        isDefault: boolean;
        phase: string | null;
        message: string | null;
        lastValidated: string | null;
        accessMode: string | null;
      }[]
    | null;
  recentBackups: ResourceRow[] | null;
  recentRestores: ResourceRow[] | null;
}

interface Aggregates {
  backupGroups: { clusterId: string; phase: string | null; _count: { _all: number } }[];
  scheduleGroups: { clusterId: string; phase: string | null; _count: { _all: number } }[];
  storageGroups: { clusterId: string; phase: string | null; _count: { _all: number } }[];
  latest: Map<
    string,
    { clusterId: string; name: string; phase: string | null; completedAt: Date | null }
  >;
}

/** Tunable so tests, which read what they just wrote, can switch the sharing off. */
export const fleetOptions = { cacheMs: 5_000 };

interface ResourceRow {
  name: string;
  phase: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdByVfm: boolean;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value.slice(0, 256) : null;

/**
 * Read models for the fleet overview and a cluster's overview (PLAN.md §11.1
 * pages 2 and 3). Everything is gated by what the caller may read **per
 * cluster**, decided in bulk, and a section the caller may not read is `null`
 * (absent), never a zero that would itself be information.
 */
@Injectable()
export class FleetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clusters: ClustersService,
    private readonly rbac: RbacService,
  ) {}

  private readonly cache = new Map<string, { at: number; value: Promise<Aggregates> }>();

  /**
   * The counts behind the fleet page, for every cluster of the org at once, shared by everyone who
   * asks within a few seconds. They are the expensive part (a full read of the org's backups,
   * schedules and locations) and they are the same for everybody: what differs per person is which
   * clusters' rows they may see, which is applied afterwards. Without this, a hundred people
   * keeping the page open cost a hundred full reads every time something changed.
   */
  private aggregates(orgId: string): Promise<Aggregates> {
    const held = this.cache.get(orgId);
    if (held !== undefined && Date.now() - held.at < fleetOptions.cacheMs) {
      return held.value;
    }
    const value = this.readAggregates(orgId);
    this.cache.set(orgId, { at: Date.now(), value });
    // A failure is not kept: the next caller asks again.
    value.catch(() => {
      if (this.cache.get(orgId)?.value === value) this.cache.delete(orgId);
    });
    return value;
  }

  private async readAggregates(orgId: string): Promise<Aggregates> {
    const [backupGroups, lastCompleted, scheduleGroups, storageGroups] = await this.prisma.inOrg(
      orgId,
      () =>
        Promise.all([
          this.prisma.veleroResource.groupBy({
            by: ['clusterId', 'phase'],
            where: { kind: 'BACKUP', deletedAt: null },
            _count: { _all: true },
          }),
          this.prisma.veleroResource.groupBy({
            by: ['clusterId'],
            where: { kind: 'BACKUP', deletedAt: null, completedAt: { not: null } },
            _max: { completedAt: true },
          }),
          this.prisma.veleroResource.groupBy({
            by: ['clusterId', 'phase'],
            where: { kind: 'SCHEDULE', deletedAt: null },
            _count: { _all: true },
          }),
          this.prisma.veleroResource.groupBy({
            by: ['clusterId', 'phase'],
            where: { kind: 'BACKUP_STORAGE_LOCATION', deletedAt: null },
            _count: { _all: true },
          }),
        ]),
    );
    // The most recent finished backup per cluster: one more query for the rows
    // behind the per-cluster maxima, instead of loading every backup.
    const maxima = lastCompleted.flatMap((g) =>
      g._max.completedAt === null
        ? []
        : [{ clusterId: g.clusterId, completedAt: g._max.completedAt }],
    );
    const latestRows =
      maxima.length === 0
        ? []
        : await this.prisma.inOrg(orgId, () =>
            this.prisma.veleroResource.findMany({
              where: { kind: 'BACKUP', deletedAt: null, OR: maxima },
              select: { clusterId: true, name: true, phase: true, completedAt: true },
              orderBy: { name: 'asc' },
            }),
          );
    return {
      backupGroups,
      scheduleGroups,
      storageGroups,
      latest: new Map(latestRows.map((r) => [r.clusterId, r])),
    };
  }

  async fleet(orgId: string, userId: string, token?: TokenLimit): Promise<FleetCluster[]> {
    const visible = await this.clusters.list(orgId, userId, token);
    if (visible.length === 0) {
      return [];
    }
    const ids = visible.map((c) => c.id);
    const held = await this.rbac.matrix(orgId, userId, ids, READ_PERMISSIONS, token);
    const may = (id: string, p: Permission): boolean => held.get(id)?.has(p) === true;

    const { backupGroups, scheduleGroups, storageGroups, latest } = await this.aggregates(orgId);
    const syncs = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findMany({
        where: { id: { in: ids } },
        select: { id: true, inventorySyncedAt: true },
      }),
    );
    const synced = new Map(syncs.map((s) => [s.id, s.inventorySyncedAt]));

    return visible.map((cluster): FleetCluster => {
      const byPhase: Record<string, number> = {};
      let backupTotal = 0;
      for (const g of backupGroups.filter((x) => x.clusterId === cluster.id)) {
        byPhase[g.phase ?? 'Unknown'] = g._count._all;
        backupTotal += g._count._all;
      }
      const schedules = scheduleGroups.filter((x) => x.clusterId === cluster.id);
      const storage = storageGroups.filter((x) => x.clusterId === cluster.id);
      const count = (rows: typeof storage, phase: string): number =>
        rows.filter((r) => r.phase === phase).reduce((n, r) => n + r._count._all, 0);
      const last = latest.get(cluster.id);

      return {
        ...cluster,
        syncedAt: synced.get(cluster.id) ?? null,
        backups: may(cluster.id, 'backup:read')
          ? {
              total: backupTotal,
              byPhase,
              last:
                last === undefined
                  ? null
                  : { name: last.name, phase: last.phase, completedAt: last.completedAt },
            }
          : null,
        schedules: may(cluster.id, 'schedule:read')
          ? {
              total: schedules.reduce((n, r) => n + r._count._all, 0),
              failing: count(schedules, 'FailedValidation'),
            }
          : null,
        storage: may(cluster.id, 'storage:read')
          ? {
              total: storage.reduce((n, r) => n + r._count._all, 0),
              available: count(storage, 'Available'),
              unavailable: count(storage, 'Unavailable'),
            }
          : null,
      };
    });
  }

  async overview(
    orgId: string,
    userId: string,
    clusterId: string,
    token?: TokenLimit,
  ): Promise<ClusterOverview> {
    const cluster = await this.clusters.get(orgId, clusterId);
    const held = (await this.rbac.matrix(orgId, userId, [clusterId], READ_PERMISSIONS, token)).get(
      clusterId,
    );
    if (held === undefined) {
      throw new NotFoundException('cluster not found');
    }
    const allowedKinds = KIND_NAMES.filter((kind) => {
      const permission = permissionForKindName(kind);
      return permission !== undefined && held.has(permission);
    });

    const recent = (kind: 'BACKUP' | 'RESTORE') =>
      this.prisma.veleroResource.findMany({
        where: { clusterId, kind, deletedAt: null },
        orderBy: [{ startedAt: { sort: 'desc', nulls: 'last' } }, { name: 'desc' }],
        take: 10,
        select: { name: true, phase: true, startedAt: true, completedAt: true, createdByVfm: true },
      });

    const [groups, locations, backups, restores, row] = await this.prisma.inOrg(orgId, () =>
      Promise.all([
        this.prisma.veleroResource.groupBy({
          by: ['kind', 'phase'],
          where: { clusterId, deletedAt: null, kind: { in: allowedKinds } },
          _count: { _all: true },
        }),
        held.has('storage:read')
          ? this.prisma.veleroResource.findMany({
              where: { clusterId, kind: 'BACKUP_STORAGE_LOCATION', deletedAt: null },
              orderBy: { name: 'asc' },
              select: { name: true, spec: true, status: true, phase: true },
            })
          : Promise.resolve(null),
        held.has('backup:read') ? recent('BACKUP') : Promise.resolve(null),
        held.has('restore:read') ? recent('RESTORE') : Promise.resolve(null),
        this.prisma.cluster.findUnique({
          where: { id: clusterId },
          select: { inventorySnapshotId: true, inventorySyncedAt: true },
        }),
      ]),
    );

    const kinds: ClusterOverview['inventory']['kinds'] = {};
    for (const kind of allowedKinds) {
      kinds[kind] = { total: 0, byPhase: {} };
    }
    for (const g of groups) {
      const entry = kinds[g.kind];
      if (entry !== undefined) {
        entry.total += g._count._all;
        entry.byPhase[g.phase ?? 'Unknown'] = g._count._all;
      }
    }

    const object = (value: unknown): Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return {
      cluster,
      inventory: {
        snapshotId: row?.inventorySnapshotId ?? null,
        syncedAt: row?.inventorySyncedAt ?? null,
        kinds,
      },
      locations:
        locations?.map((l) => {
          const spec = object(l.spec);
          const status = object(l.status);
          return {
            name: l.name,
            provider: str(spec.provider),
            isDefault: spec.default === true,
            phase: l.phase,
            message: str(status.message),
            lastValidated: str(status.lastValidationTime),
            accessMode: str(status.accessMode) ?? str(spec.accessMode),
          };
        }) ?? null,
      recentBackups: backups,
      recentRestores: restores,
    };
  }
}
