import { useInfiniteQuery } from '@tanstack/react-query';

import { api } from './client';
import { useRefreshInterval } from './events';

/** Rows of the lists and the detail pages (see `GET /orgs/{org}/clusters/{id}/{backups|…}`). */

export interface Scope {
  all: boolean;
  namespaces: string[];
  more: number;
}

export interface BackupRow {
  name: string;
  phase: string | null;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  createdByVfm: boolean;
  schedule: string | null;
  storageLocation: string | null;
  ttl: string | null;
  scope: Scope;
  includesClusterResources: boolean;
  warnings: number;
  errors: number;
  itemsBackedUp: number | null;
  totalItems: number | null;
  volumeSnapshots: { attempted: number | null; completed: number | null };
  failureReason: string | null;
}

export interface RestoreRow {
  name: string;
  phase: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdByVfm: boolean;
  backupName: string | null;
  scheduleName: string | null;
  scope: Scope;
  existingResourcePolicy: string | null;
  warnings: number;
  errors: number;
  itemsRestored: number | null;
  totalItems: number | null;
  failureReason: string | null;
}

export interface ScheduleRow {
  name: string;
  phase: string | null;
  createdByVfm: boolean;
  cron: string | null;
  paused: boolean;
  lastBackup: string | null;
  storageLocation: string | null;
  ttl: string | null;
  scope: Scope;
  validationErrors: string[];
}

export interface LocationRow {
  name: string;
  kind: string;
  phase: string | null;
  provider: string | null;
  isDefault: boolean;
  bucket: string | null;
  prefix: string | null;
  accessMode: string | null;
  message: string | null;
  lastValidated: string | null;
  credential: { name: string | null; key: string | null } | null;
}

export interface RepositoryRow {
  name: string;
  phase: string | null;
  repositoryType: string | null;
  volumeNamespace: string | null;
  storageLocation: string | null;
  maintenanceFrequency: string | null;
  lastMaintenance: string | null;
  message: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Detail<T> {
  summary: T;
  timeline: { at: string; event: string }[];
  labels: Record<string, string>;
  spec: unknown;
  status: unknown;
  yaml: string;
  volumes: {
    kind: string;
    name: string;
    phase: string | null;
    uploader: string | null;
    bytesDone: number | null;
    totalBytes: number | null;
  }[];
}

export type Filters = Record<string, string | undefined>;

/** The query string for a list: only what is set. */
export function queryString(filters: Filters, cursor?: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') {
      params.set(key, value);
    }
  }
  params.set('limit', '50');
  if (cursor !== undefined) {
    params.set('cursor', cursor);
  }
  return params.toString();
}

/**
 * A list read page by page. The cursor belongs to the filters that produced it, so
 * changing a filter is a new query (a new key) that starts again from the first page,
 * never a cursor carried across.
 */
export function useResourceList<T>(
  orgId: string,
  clusterId: string,
  path: string,
  filters: Filters,
) {
  const interval = useRefreshInterval();
  return useInfiniteQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'list', path, filters],
    refetchInterval: interval,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<Page<T>>(
        `/orgs/${orgId}/clusters/${clusterId}/${path}?${queryString(filters, pageParam)}`,
        {
          signal,
        },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Phase filter choices; a choice may stand for several phases (sent as a comma list). */
export const PHASE_GROUPS: { label: string; value: string }[] = [
  { label: 'Completed', value: 'Completed' },
  {
    label: 'In progress',
    value: 'New,Queued,ReadyToStart,InProgress,WaitingForPluginOperations,Finalizing',
  },
  { label: 'Failed', value: 'Failed,FailedValidation' },
  {
    label: 'Partially failed',
    value: 'PartiallyFailed,WaitingForPluginOperationsPartiallyFailed,FinalizingPartiallyFailed',
  },
  { label: 'Deleting', value: 'Deleting' },
];
