import { restoreNamespaces } from '@vfm/shared';

/**
 * What a stored Velero object means for the lists and for who may see it.
 *
 * Everything is derived from the object's own `spec` and `status`, which an agent
 * reported and which are therefore treated as untrusted display data: every read
 * is defensive and every string is bounded.
 */

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 256): string | null =>
  typeof v === 'string' && v !== '' ? v.slice(0, max) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown, limit = 200): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .slice(0, limit)
        .map((s) => s.slice(0, 253))
    : [];

export interface Covered {
  /** The namespaces the object reads or writes; `['*']` means every namespace. */
  namespaces: string[];
  /** Whether it includes cluster-scoped resources. */
  includesClusterScoped: boolean;
}

function coverOf(spec: Json, mapping: Record<string, string> | undefined): Covered {
  const included = strings(spec.includedNamespaces);
  const everything = included.length === 0 || included.includes('*');
  // Explicit and non-empty only: Velero's "auto" (unset) adds just what the selected
  // namespaced resources need and does not widen what the object touches.
  const clusterScoped =
    spec.includeClusterResources === true ||
    strings(spec.includedClusterScopedResources).length > 0;
  return {
    namespaces: everything
      ? ['*']
      : mapping === undefined
        ? included
        : restoreNamespaces(included, mapping),
    includesClusterScoped: clusterScoped,
  };
}

/**
 * The namespaces an object covers, for the visibility rule of PLAN.md §8.2: a user
 * with a scoped binding may see it only if **every** namespace is within their scope
 * and it includes no cluster-scoped resources. "Exclude" lists never narrow this: a
 * backup of "everything except prod" still reaches everything else.
 */
export function coveredBy(kind: string, spec: unknown): Covered {
  const s = isRecord(spec) ? spec : {};
  switch (kind) {
    case 'BACKUP':
      return coverOf(s, undefined);
    case 'RESTORE': {
      const raw = isRecord(s.namespaceMapping) ? s.namespaceMapping : {};
      const mapping: Record<string, string> = {};
      for (const [from, to] of Object.entries(raw)) {
        if (typeof to === 'string') {
          mapping[from] = to;
        }
      }
      return coverOf(s, mapping);
    }
    case 'SCHEDULE':
      return coverOf(isRecord(s.template) ? s.template : {}, undefined);
    default:
      // Storage and the rest are cluster-level and never namespace-filtered.
      return { namespaces: [], includesClusterScoped: false };
  }
}

interface RowLike {
  name: string;
  phase: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  createdByVfm: boolean;
  labels: unknown;
  spec: unknown;
  status: unknown;
  creationTimestamp: Date | null;
}

const labelOf = (row: RowLike, key: string): string | null =>
  isRecord(row.labels) ? text(row.labels[key]) : null;

/** A short, safe description of what an object covers: at most ten names. */
function scope(spec: unknown, kind: string): { all: boolean; namespaces: string[]; more: number } {
  const c = coveredBy(kind, spec);
  if (c.namespaces.includes('*')) {
    return { all: true, namespaces: [], more: 0 };
  }
  return {
    all: false,
    namespaces: c.namespaces.slice(0, 10),
    more: Math.max(0, c.namespaces.length - 10),
  };
}

export function backupSummary(row: RowLike) {
  const spec = isRecord(row.spec) ? row.spec : {};
  const status = isRecord(row.status) ? row.status : {};
  const progress = isRecord(status.progress) ? status.progress : {};
  return {
    name: row.name,
    phase: row.phase,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
    createdByVfm: row.createdByVfm,
    schedule: labelOf(row, 'velero.io/schedule-name'),
    storageLocation: text(spec.storageLocation),
    ttl: text(spec.ttl, 32),
    scope: scope(row.spec, 'BACKUP'),
    includesClusterResources: coveredBy('BACKUP', row.spec).includesClusterScoped,
    warnings: num(status.warnings) ?? 0,
    errors: num(status.errors) ?? 0,
    itemsBackedUp: num(progress.itemsBackedUp),
    totalItems: num(progress.totalItems),
    volumeSnapshots: {
      attempted: num(status.volumeSnapshotsAttempted) ?? num(status.csiVolumeSnapshotsAttempted),
      completed: num(status.volumeSnapshotsCompleted) ?? num(status.csiVolumeSnapshotsCompleted),
    },
    failureReason: text(status.failureReason, 512),
  };
}

export function restoreSummary(row: RowLike) {
  const spec = isRecord(row.spec) ? row.spec : {};
  const status = isRecord(row.status) ? row.status : {};
  const progress = isRecord(status.progress) ? status.progress : {};
  return {
    name: row.name,
    phase: row.phase,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdByVfm: row.createdByVfm,
    backupName: text(spec.backupName),
    scheduleName: text(spec.scheduleName),
    scope: scope(row.spec, 'RESTORE'),
    existingResourcePolicy: text(spec.existingResourcePolicy, 16),
    warnings: num(status.warnings) ?? 0,
    errors: num(status.errors) ?? 0,
    itemsRestored: num(progress.itemsRestored),
    totalItems: num(progress.totalItems),
    failureReason: text(status.failureReason, 512),
  };
}

export function scheduleSummary(row: RowLike) {
  const spec = isRecord(row.spec) ? row.spec : {};
  const status = isRecord(row.status) ? row.status : {};
  const template = isRecord(spec.template) ? spec.template : {};
  return {
    name: row.name,
    phase: row.phase,
    createdByVfm: row.createdByVfm,
    cron: text(spec.schedule, 128),
    paused: spec.paused === true,
    lastBackup: text(status.lastBackup, 40),
    storageLocation: text(template.storageLocation),
    ttl: text(template.ttl, 32),
    scope: scope(row.spec, 'SCHEDULE'),
    validationErrors: strings(status.validationErrors, 5),
  };
}

export function locationSummary(row: RowLike, kind: string) {
  const spec = isRecord(row.spec) ? row.spec : {};
  const status = isRecord(row.status) ? row.status : {};
  const objectStorage = isRecord(spec.objectStorage) ? spec.objectStorage : {};
  return {
    name: row.name,
    kind,
    phase: row.phase,
    provider: text(spec.provider),
    isDefault: spec.default === true,
    bucket: text(objectStorage.bucket),
    prefix: text(objectStorage.prefix),
    accessMode: text(status.accessMode) ?? text(spec.accessMode, 16),
    message: text(status.message, 512),
    lastValidated: text(status.lastValidationTime, 40),
    lastSynced: text(status.lastSyncedTime, 40),
    // The reference to a credential, never a credential: the object holds none.
    credential: isRecord(spec.credential)
      ? { name: text(spec.credential.name, 253), key: text(spec.credential.key, 253) }
      : null,
  };
}

export function repositorySummary(row: RowLike) {
  const spec = isRecord(row.spec) ? row.spec : {};
  const status = isRecord(row.status) ? row.status : {};
  return {
    name: row.name,
    phase: row.phase,
    repositoryType: text(spec.repositoryType, 32),
    volumeNamespace: text(spec.volumeNamespace),
    storageLocation: text(spec.backupStorageLocation),
    maintenanceFrequency: text(spec.maintenanceFrequency, 32),
    lastMaintenance: text(status.lastMaintenanceTime, 40),
    message: text(status.message, 512),
  };
}

/** The ordered moments of an object's life, for the detail page's timeline. */
export function timeline(row: RowLike): { at: Date; event: string }[] {
  const out: { at: Date; event: string }[] = [];
  const add = (at: Date | null, event: string): void => {
    if (at !== null) {
      out.push({ at, event });
    }
  };
  add(row.creationTimestamp, 'Created');
  add(row.startedAt, 'Started');
  add(row.completedAt, row.phase === null ? 'Finished' : `Finished: ${row.phase}`);
  add(row.expiresAt, 'Expires');
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
