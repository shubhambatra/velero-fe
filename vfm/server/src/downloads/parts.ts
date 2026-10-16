import type { Permission } from '@vfm/shared';

import { DownloadTargetKind } from '../gateway/pb/vfm/agent/v1/velero';

/**
 * The files Velero can produce for a backup or restore and the control plane
 * serves (PLAN.md §7.3, §3). One entry per file keeps the set closed: a URL cannot
 * name a part that is not listed, and `BackupContents` — the backup's data — is
 * deliberately absent, because it is never proxied (P2).
 */
export type ObjectKind = 'BACKUP' | 'RESTORE';

export interface Part {
  /** Stored with the file; stable. */
  key: string;
  kind: ObjectKind;
  /** The path segment: `logs` or `details/<slug>`. */
  slug: string;
  target: DownloadTargetKind;
  /** The permission to read it: logs have their own, details follow `read`. */
  permission: Permission;
}

const part = (
  key: string,
  kind: ObjectKind,
  slug: string,
  target: DownloadTargetKind,
  permission: Permission,
): Part => ({ key, kind, slug, target, permission });

const T = DownloadTargetKind;

export const PARTS: readonly Part[] = [
  part('BACKUP_LOG', 'BACKUP', 'logs', T.DOWNLOAD_TARGET_KIND_BACKUP_LOG, 'backup:logs'),
  part('BACKUP_RESULTS', 'BACKUP', 'results', T.DOWNLOAD_TARGET_KIND_BACKUP_RESULTS, 'backup:read'),
  part(
    'BACKUP_RESOURCE_LIST',
    'BACKUP',
    'resource-list',
    T.DOWNLOAD_TARGET_KIND_BACKUP_RESOURCE_LIST,
    'backup:read',
  ),
  part(
    'BACKUP_ITEM_OPERATIONS',
    'BACKUP',
    'item-operations',
    T.DOWNLOAD_TARGET_KIND_BACKUP_ITEM_OPERATIONS,
    'backup:read',
  ),
  part(
    'BACKUP_VOLUME_INFOS',
    'BACKUP',
    'volume-infos',
    T.DOWNLOAD_TARGET_KIND_BACKUP_VOLUME_INFOS,
    'backup:read',
  ),
  part(
    'BACKUP_VOLUME_SNAPSHOTS',
    'BACKUP',
    'volume-snapshots',
    T.DOWNLOAD_TARGET_KIND_BACKUP_VOLUME_SNAPSHOTS,
    'backup:read',
  ),
  part('RESTORE_LOG', 'RESTORE', 'logs', T.DOWNLOAD_TARGET_KIND_RESTORE_LOG, 'restore:logs'),
  part(
    'RESTORE_RESULTS',
    'RESTORE',
    'results',
    T.DOWNLOAD_TARGET_KIND_RESTORE_RESULTS,
    'restore:read',
  ),
  part(
    'RESTORE_RESOURCE_LIST',
    'RESTORE',
    'resource-list',
    T.DOWNLOAD_TARGET_KIND_RESTORE_RESOURCE_LIST,
    'restore:read',
  ),
  part(
    'RESTORE_ITEM_OPERATIONS',
    'RESTORE',
    'item-operations',
    T.DOWNLOAD_TARGET_KIND_RESTORE_ITEM_OPERATIONS,
    'restore:read',
  ),
  part(
    'RESTORE_VOLUME_INFO',
    'RESTORE',
    'volume-info',
    T.DOWNLOAD_TARGET_KIND_RESTORE_VOLUME_INFO,
    'restore:read',
  ),
];

export const partByKey = (key: string): Part | undefined => PARTS.find((p) => p.key === key);

export const findPart = (kind: ObjectKind, slug: string): Part | undefined =>
  PARTS.find((p) => p.kind === kind && p.slug === slug);

/** Phases after which Velero's files no longer change, so a copy may be kept for days. */
export const TERMINAL_PHASES: ReadonlySet<string> = new Set([
  'Completed',
  'PartiallyFailed',
  'Failed',
  'FailedValidation',
  'WaitingForPluginOperationsPartiallyFailed',
]);

/** A copy of a file of an object still running is kept only this long. */
export const LIVE_COPY_SECONDS = 30;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
