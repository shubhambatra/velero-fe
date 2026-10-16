import { createHash } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Permission } from '@vfm/shared';
import type { Prisma, VeleroResource } from '@prisma/client';
import { stringify } from 'yaml';

import { PrismaService } from '../prisma/prisma.service';
import { WatchScopeService } from './watch-scope.service';
import { RbacService, type TokenLimit } from '../rbac/rbac.service';
import {
  backupSummary,
  coveredBy,
  coveredByRow,
  eventSummary,
  namespaceSummary,
  nodeSummary,
  podSummary,
  pvcSummary,
  locationSummary,
  repositorySummary,
  restoreSummary,
  scheduleSummary,
  timeline,
} from './projections';

/** The kinds with a detail view, and the Velero kind each is. */
const DETAIL_OBJECT_KIND = {
  BACKUP: 'Backup',
  RESTORE: 'Restore',
  SCHEDULE: 'Schedule',
  BACKUP_STORAGE_LOCATION: 'BackupStorageLocation',
  VOLUME_SNAPSHOT_LOCATION: 'VolumeSnapshotLocation',
} as const;
export type DetailKind = keyof typeof DETAIL_OBJECT_KIND;

export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 50;
/** How many rows one request may examine while filtering for visibility. */
const MAX_SCAN = 2_000;

export type ListKind =
  | 'BACKUP'
  | 'RESTORE'
  | 'SCHEDULE'
  | 'BACKUP_STORAGE_LOCATION'
  | 'VOLUME_SNAPSHOT_LOCATION'
  | 'BACKUP_REPOSITORY'
  | 'NODE'
  | 'NAMESPACE'
  | 'POD'
  | 'PERSISTENT_VOLUME_CLAIM'
  | 'EVENT';

interface KindConfig {
  permission: Permission;
  /** The permission whose namespace scope decides what a scoped user sees; defaults to `permission`. */
  visibilityPermission?: Permission;
  /** Whether visibility depends on the namespaces an object covers. */
  namespaced: boolean;
  sorts: readonly string[];
  defaultSort: string;
  defaultOrder: 'asc' | 'desc';
  summarize: (row: VeleroResource, kind: ListKind) => unknown;
}

const CONFIG: Record<ListKind, KindConfig> = {
  BACKUP: {
    permission: 'backup:read',
    namespaced: true,
    sorts: ['startedAt', 'completedAt', 'expiresAt', 'name', 'phase'],
    defaultSort: 'startedAt',
    defaultOrder: 'desc',
    summarize: (r) => backupSummary(r),
  },
  RESTORE: {
    permission: 'restore:read',
    namespaced: true,
    sorts: ['startedAt', 'completedAt', 'name', 'phase'],
    defaultSort: 'startedAt',
    defaultOrder: 'desc',
    summarize: (r) => restoreSummary(r),
  },
  SCHEDULE: {
    permission: 'schedule:read',
    namespaced: true,
    sorts: ['name', 'phase'],
    defaultSort: 'name',
    defaultOrder: 'asc',
    summarize: (r) => scheduleSummary(r),
  },
  BACKUP_STORAGE_LOCATION: {
    permission: 'storage:read',
    namespaced: false,
    sorts: ['name', 'phase'],
    defaultSort: 'name',
    defaultOrder: 'asc',
    summarize: (r, k) => locationSummary(r, k),
  },
  VOLUME_SNAPSHOT_LOCATION: {
    permission: 'storage:read',
    namespaced: false,
    sorts: ['name', 'phase'],
    defaultSort: 'name',
    defaultOrder: 'asc',
    summarize: (r, k) => locationSummary(r, k),
  },
  NODE: {
    permission: 'cluster:read',
    namespaced: false,
    sorts: ['name', 'phase'],
    defaultSort: 'name',
    defaultOrder: 'asc',
    summarize: (r) => nodeSummary(r),
  },
  NAMESPACE: {
    permission: 'cluster:read',
    visibilityPermission: 'backup:read',
    namespaced: true,
    sorts: ['name', 'phase'],
    defaultSort: 'name',
    defaultOrder: 'asc',
    summarize: (r) => namespaceSummary(r),
  },
  POD: {
    permission: 'cluster:read',
    visibilityPermission: 'backup:read',
    namespaced: true,
    sorts: ['name', 'phase', 'startedAt'],
    defaultSort: 'name',
    defaultOrder: 'asc',
    summarize: (r) => podSummary(r),
  },
  PERSISTENT_VOLUME_CLAIM: {
    permission: 'cluster:read',
    visibilityPermission: 'backup:read',
    namespaced: true,
    sorts: ['name', 'phase'],
    defaultSort: 'name',
    defaultOrder: 'asc',
    summarize: (r) => pvcSummary(r),
  },
  EVENT: {
    permission: 'cluster:read',
    visibilityPermission: 'backup:read',
    namespaced: true,
    sorts: ['startedAt', 'name'],
    defaultSort: 'startedAt',
    defaultOrder: 'desc',
    summarize: (r) => eventSummary(r),
  },
  BACKUP_REPOSITORY: {
    permission: 'storage:read',
    namespaced: false,
    sorts: ['name', 'phase'],
    defaultSort: 'name',
    defaultOrder: 'asc',
    summarize: (r) => repositorySummary(r),
  },
};

export interface ListQuery {
  phase?: string[];
  /** Case-insensitive substring of the name. */
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  cursor?: string;
  // Kind-specific filters.
  schedule?: string;
  location?: string;
  backup?: string;
  paused?: boolean;
  createdByVfm?: boolean;
  /** The live view's namespace filter. */
  namespace?: string;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page; `null` when there is no more. */
  nextCursor: string | null;
}

/** A filter this kind does not support, named so the caller can fix the request. */
const SUPPORTED_FILTERS: Record<ListKind, readonly (keyof ListQuery)[]> = {
  BACKUP: ['phase', 'q', 'schedule', 'location', 'createdByVfm'],
  RESTORE: ['phase', 'q', 'backup', 'schedule', 'createdByVfm'],
  SCHEDULE: ['phase', 'q', 'paused', 'createdByVfm'],
  BACKUP_STORAGE_LOCATION: ['phase', 'q'],
  VOLUME_SNAPSHOT_LOCATION: ['phase', 'q'],
  BACKUP_REPOSITORY: ['phase', 'q'],
  NODE: ['phase', 'q'],
  NAMESPACE: ['phase', 'q'],
  POD: ['phase', 'q', 'namespace'],
  PERSISTENT_VOLUME_CLAIM: ['phase', 'q', 'namespace'],
  EVENT: ['phase', 'q', 'namespace'],
};

const FILTER_KEYS: (keyof ListQuery)[] = [
  'phase',
  'q',
  'schedule',
  'location',
  'backup',
  'paused',
  'createdByVfm',
  'namespace',
];

/**
 * The read side of the inventory: lists with filters, sorting and cursor pagination,
 * and detail views (PLAN.md §10, §11.1). Every read goes through the same visibility
 * rule as a direct request, so a list can never show what a detail page would hide.
 */
@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly watch: WatchScopeService,
  ) {}

  async list(
    orgId: string,
    userId: string,
    clusterId: string,
    kind: ListKind,
    query: ListQuery,
    token?: TokenLimit,
  ): Promise<Page<unknown>> {
    const config = CONFIG[kind];
    const sort = query.sort ?? config.defaultSort;
    if (!config.sorts.includes(sort)) {
      throw new BadRequestException(
        `cannot sort by ${sort}; use one of ${config.sorts.join(', ')}`,
      );
    }
    for (const key of FILTER_KEYS) {
      if (query[key] !== undefined && !SUPPORTED_FILTERS[kind].includes(key)) {
        throw new BadRequestException(`this list cannot be filtered by ${key}`);
      }
    }
    const order = query.order ?? config.defaultOrder;
    const limit = Math.min(Math.max(query.limit, 1), MAX_PAGE);

    // A cursor is only meaningful for the query that produced it.
    const signature = createHash('sha256')
      .update(JSON.stringify({ kind, sort, order, f: FILTER_KEYS.map((k) => query[k] ?? null) }))
      .digest('base64url')
      .slice(0, 12);
    const after =
      query.cursor === undefined ? undefined : this.decodeCursor(query.cursor, signature);

    const where: Prisma.VeleroResourceWhereInput = {
      clusterId,
      kind,
      deletedAt: null,
      ...(query.phase === undefined ? {} : { phase: { in: query.phase } }),
      ...(query.q === undefined ? {} : { name: { contains: query.q, mode: 'insensitive' } }),
      ...(query.createdByVfm === undefined ? {} : { createdByVfm: query.createdByVfm }),
      ...(query.namespace === undefined ? {} : { namespace: query.namespace }),
      // Events are interesting for an hour (PLAN.md §7.1); the agent retires older ones, this
      // covers the gap until it does.
      ...(kind === 'EVENT' ? { startedAt: { gte: new Date(Date.now() - 3_600_000) } } : {}),
      ...(query.schedule === undefined
        ? {}
        : kind === 'RESTORE'
          ? { spec: { path: ['scheduleName'], equals: query.schedule } }
          : { labels: { path: ['velero.io/schedule-name'], equals: query.schedule } }),
      ...(query.location === undefined
        ? {}
        : { spec: { path: ['storageLocation'], equals: query.location } }),
      ...(query.backup === undefined
        ? {}
        : { spec: { path: ['backupName'], equals: query.backup } }),
      ...(query.paused === true ? { spec: { path: ['paused'], equals: true } } : {}),
    };
    const orderBy: Prisma.VeleroResourceOrderByWithRelationInput[] = [
      sort === 'name' || sort === 'phase'
        ? { [sort]: order }
        : { [sort]: { sort: order, nulls: 'last' } },
      { id: 'asc' },
    ];

    const visibility = config.namespaced
      ? await this.rbac.visibility(
          orgId,
          userId,
          clusterId,
          config.visibilityPermission ?? config.permission,
          token,
        )
      : undefined;
    // Looking at a namespace's pods asks the agent of a large cluster to report them.
    if (
      kind === 'POD' &&
      query.namespace !== undefined &&
      (visibility === undefined ||
        visibility.all ||
        visibility.sees({ namespaces: [query.namespace], includesClusterScoped: false }))
    ) {
      await this.watch.touch(clusterId, query.namespace).catch(() => undefined);
    }
    // An unpaused schedule usually omits `paused`, and in SQL a missing JSON key is NULL,
    // which no `NOT` can match. "Not paused" is therefore decided here, in the scan.
    const notPaused = query.paused === false;
    const isPaused = (spec: unknown): boolean =>
      typeof spec === 'object' &&
      spec !== null &&
      (spec as Record<string, unknown>).paused === true;
    const filtering = (visibility !== undefined && !visibility.all) || notPaused;

    const items: unknown[] = [];
    let cursorId = after;
    let more = false;
    let scanned = 0;

    while (items.length < limit && scanned < MAX_SCAN) {
      const take = filtering ? Math.min(limit * 2, 400) : limit + 1;
      const rows = await this.prisma.inOrg(orgId, () =>
        this.prisma.veleroResource.findMany({
          where,
          orderBy,
          take,
          ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
        }),
      );
      if (rows.length === 0) {
        more = false;
        break;
      }

      let consumed = 0;
      for (const row of rows) {
        if (!filtering && items.length === limit) {
          break;
        }
        consumed += 1;
        scanned += 1;
        cursorId = row.id;
        const visible =
          visibility === undefined || visibility.all || visibility.sees(coveredByRow(kind, row));
        if (visible && !(notPaused && isPaused(row.spec))) {
          items.push(config.summarize(row, kind));
          if (items.length === limit) {
            break;
          }
        }
      }

      if (!filtering) {
        // Fetched limit + 1: one extra row proves there is another page.
        more = rows.length > limit;
        break;
      }
      // Filtering: a full batch means there may be more beyond what was examined.
      more = consumed < rows.length || rows.length === take;
      if (items.length === limit) {
        break;
      }
      if (rows.length < take) {
        more = false;
        break;
      }
    }
    if (items.length < limit && scanned >= MAX_SCAN) {
      more = true;
    }

    return {
      items,
      nextCursor: more && cursorId !== undefined ? this.encodeCursor(cursorId, signature) : null,
    };
  }

  /** One backup, restore or schedule, with its timeline and a YAML rendering. 404 when absent or not visible. */
  async detail(
    orgId: string,
    userId: string,
    clusterId: string,
    kind: DetailKind,
    name: string,
    token?: TokenLimit,
  ) {
    const noun = DETAIL_OBJECT_KIND[kind].toLowerCase();
    const config = CONFIG[kind];
    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.findFirst({ where: { clusterId, kind, name, deletedAt: null } }),
    );
    const visibility = await this.rbac.visibility(
      orgId,
      userId,
      clusterId,
      config.permission,
      token,
    );
    // The same answer for "there is none" and "you may not see it": a 403 would
    // confirm that a backup of that name exists.
    if (row === null || !(visibility.all || visibility.sees(coveredBy(kind, row.spec)))) {
      throw new NotFoundException(`${noun} not found`);
    }

    const related =
      kind === 'BACKUP'
        ? await this.prisma.inOrg(orgId, () =>
            this.prisma.veleroResource.findMany({
              where: {
                clusterId,
                kind: { in: ['POD_VOLUME_BACKUP', 'DATA_UPLOAD'] },
                deletedAt: null,
                labels: { path: ['velero.io/backup-name'], equals: name },
              },
              orderBy: { name: 'asc' },
              take: 200,
            }),
          )
        : [];

    const object = {
      apiVersion: 'velero.io/v1',
      kind: DETAIL_OBJECT_KIND[kind],
      metadata: { name: row.name, namespace: row.namespace, labels: row.labels },
      spec: row.spec,
      status: row.status,
    };
    return {
      summary: config.summarize(row, kind),
      timeline: timeline(row),
      labels: row.labels,
      spec: row.spec,
      status: row.status,
      yaml: stringify(object, { lineWidth: 0 }),
      volumes: related.map((v) => {
        const spec =
          typeof v.spec === 'object' && v.spec !== null ? (v.spec as Record<string, unknown>) : {};
        const status =
          typeof v.status === 'object' && v.status !== null
            ? (v.status as Record<string, unknown>)
            : {};
        const progress =
          typeof status.progress === 'object' && status.progress !== null
            ? (status.progress as Record<string, unknown>)
            : {};
        return {
          kind: v.kind,
          name: v.name,
          phase: v.phase,
          uploader: typeof spec.uploaderType === 'string' ? spec.uploaderType.slice(0, 32) : null,
          bytesDone: typeof progress.bytesDone === 'number' ? progress.bytesDone : null,
          totalBytes: typeof progress.totalBytes === 'number' ? progress.totalBytes : null,
        };
      }),
    };
  }

  private encodeCursor(id: string, signature: string): string {
    return Buffer.from(JSON.stringify({ id, s: signature })).toString('base64url');
  }

  private decodeCursor(cursor: string, signature: string): string {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        id?: unknown;
        s?: unknown;
      };
      if (
        typeof parsed.id === 'string' &&
        /^[0-9a-f-]{36}$/.test(parsed.id) &&
        parsed.s === signature
      ) {
        return parsed.id;
      }
    } catch {
      // fall through
    }
    throw new BadRequestException(
      'the cursor is not valid for this query; start again from the first page',
    );
  }
}
