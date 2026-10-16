import type { Permission } from '@vfm/shared';

import { ResourceKind } from '../gateway/pb/vfm/agent/v1/inventory';

export interface KindInfo {
  /** Stored in `velero_resources.kind`. */
  name: string;
  /** The `kind` the object itself must declare. */
  objectKind: string;
  /** What a user needs to see objects (or learn they changed) of this kind. */
  permission: Permission;
}

/**
 * The kinds the control plane accepts from an agent. Anything absent is refused:
 * the protocol enum also names core kinds (Node, Pod, ...) that arrive with M5, and
 * an agent has no business sending those before the ingest for them exists.
 */
const TABLE: ReadonlyMap<ResourceKind, KindInfo> = new Map([
  [
    ResourceKind.RESOURCE_KIND_BACKUP,
    { name: 'BACKUP', objectKind: 'Backup', permission: 'backup:read' },
  ],
  [
    ResourceKind.RESOURCE_KIND_RESTORE,
    { name: 'RESTORE', objectKind: 'Restore', permission: 'restore:read' },
  ],
  [
    ResourceKind.RESOURCE_KIND_SCHEDULE,
    { name: 'SCHEDULE', objectKind: 'Schedule', permission: 'schedule:read' },
  ],
  [
    ResourceKind.RESOURCE_KIND_BACKUP_STORAGE_LOCATION,
    {
      name: 'BACKUP_STORAGE_LOCATION',
      objectKind: 'BackupStorageLocation',
      permission: 'storage:read',
    },
  ],
  [
    ResourceKind.RESOURCE_KIND_VOLUME_SNAPSHOT_LOCATION,
    {
      name: 'VOLUME_SNAPSHOT_LOCATION',
      objectKind: 'VolumeSnapshotLocation',
      permission: 'storage:read',
    },
  ],
  [
    ResourceKind.RESOURCE_KIND_BACKUP_REPOSITORY,
    { name: 'BACKUP_REPOSITORY', objectKind: 'BackupRepository', permission: 'storage:read' },
  ],
  [
    ResourceKind.RESOURCE_KIND_POD_VOLUME_BACKUP,
    { name: 'POD_VOLUME_BACKUP', objectKind: 'PodVolumeBackup', permission: 'backup:read' },
  ],
  [
    ResourceKind.RESOURCE_KIND_POD_VOLUME_RESTORE,
    { name: 'POD_VOLUME_RESTORE', objectKind: 'PodVolumeRestore', permission: 'restore:read' },
  ],
  [
    ResourceKind.RESOURCE_KIND_DATA_UPLOAD,
    { name: 'DATA_UPLOAD', objectKind: 'DataUpload', permission: 'backup:read' },
  ],
  [
    ResourceKind.RESOURCE_KIND_DATA_DOWNLOAD,
    { name: 'DATA_DOWNLOAD', objectKind: 'DataDownload', permission: 'restore:read' },
  ],
  [
    ResourceKind.RESOURCE_KIND_DELETE_BACKUP_REQUEST,
    { name: 'DELETE_BACKUP_REQUEST', objectKind: 'DeleteBackupRequest', permission: 'backup:read' },
  ],
]);

export const kindInfo = (kind: ResourceKind): KindInfo | undefined => TABLE.get(kind);

/** Permission needed to see a stored kind, by its stored name. */
export function permissionForKindName(name: string): Permission | undefined {
  for (const info of TABLE.values()) {
    if (info.name === name) {
      return info.permission;
    }
  }
  return undefined;
}

export const KIND_NAMES: readonly string[] = [...TABLE.values()].map((info) => info.name);
