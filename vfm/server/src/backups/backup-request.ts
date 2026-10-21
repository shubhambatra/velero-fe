import { z } from 'zod';

import type { Command } from '../gateway/pb/vfm/agent/v1/command';
import type { BackupSpec } from '../gateway/pb/vfm/agent/v1/velero';

/**
 * The API body of `POST …/backups` and how it becomes (a) a decision about who may
 * make it and (b) the protobuf the agent receives (PLAN.md §5.2, §6, §8.2).
 *
 * Every field is one of `velero backup create`'s flags. The schema is **strict**:
 * a field it does not know is a 422, never ignored, so a typo cannot make a backup
 * different from the one the operator meant. Hooks run commands inside workloads and
 * are therefore not a typed field: they go through `advancedSpec`, which needs
 * `advanced:write` on the whole cluster.
 */

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
export const OBJECT_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** A namespace name, or `*` for all of them. Globs such as `dev*` are not accepted here. */
export const namespace = z.union([
  z.literal('*'),
  z
    .string()
    .max(63)
    .regex(DNS_LABEL, 'a namespace name (lower-case letters, digits and "-"), or "*" for all'),
]);

export const resource = z.string().min(1).max(253);
export const names = (item: z.ZodType<string>) => z.array(item).max(200);

export const labelMap = z
  .record(z.string().min(1).max(253), z.string().max(63))
  .refine((m) => Object.keys(m).length <= 50, 'at most 50 labels');

export const selector = z
  .object({
    matchLabels: labelMap.optional(),
    matchExpressions: z
      .array(
        z
          .object({
            key: z.string().min(1).max(253),
            operator: z.enum(['In', 'NotIn', 'Exists', 'DoesNotExist']),
            values: z.array(z.string().max(63)).max(50).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();

/** A Go-style duration such as `720h`, `30m` or `1h30m`. */
export const duration = z
  .string()
  .max(40)
  .regex(/^(\d+(\.\d+)?(ms|s|m|h))+$/, 'a duration such as "720h" or "1h30m"');

export const createBackupBody = z
  .object({
    /** Empty: the agent generates `backup-<timestamp>` like the CLI. */
    name: z.string().max(63).regex(OBJECT_NAME).optional(),
    includedNamespaces: names(namespace).optional(),
    excludedNamespaces: names(namespace).optional(),
    includedResources: names(resource).optional(),
    excludedResources: names(resource).optional(),
    includedClusterScopedResources: names(resource).optional(),
    excludedClusterScopedResources: names(resource).optional(),
    includedNamespaceScopedResources: names(resource).optional(),
    excludedNamespaceScopedResources: names(resource).optional(),
    labelSelector: selector.optional(),
    orLabelSelectors: z.array(selector).max(20).optional(),
    includeClusterResources: z.boolean().optional(),
    ttl: duration.optional(),
    storageLocation: z.string().max(63).regex(OBJECT_NAME).optional(),
    volumeSnapshotLocations: z.array(z.string().max(63).regex(OBJECT_NAME)).max(20).optional(),
    snapshotVolumes: z.boolean().optional(),
    defaultVolumesToFsBackup: z.boolean().optional(),
    snapshotMoveData: z.boolean().optional(),
    dataMover: z.string().max(63).optional(),
    itemOperationTimeout: duration.optional(),
    csiSnapshotTimeout: duration.optional(),
    /** The name of a ConfigMap holding Velero resource policies. */
    resourcePolicy: z.string().max(253).regex(OBJECT_NAME).optional(),
    orderedResources: z.record(z.string().min(1).max(253), z.string().max(4096)).optional(),
    parallelFilesUpload: z.number().int().min(1).max(64).optional(),
    metadataLabels: labelMap.optional(),
    volumeGroupSnapshotLabelKey: z.string().max(253).optional(),
    /** Merged onto the spec and validated by the agent against Velero's type. */
    advancedSpec: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CreateBackupBody = z.infer<typeof createBackupBody>;

export const triggerBody = z
  .object({ backupName: z.string().max(63).regex(OBJECT_NAME).optional() })
  .strict();

// ---------------------------------------------------------------------------
// Who may make it.

export interface Coverage {
  /** The namespaces the backup reads; `['*']` means every namespace. */
  namespaces: string[];
  includesClusterScoped: boolean;
}

interface CoverageInput {
  includedNamespaces?: readonly string[] | undefined;
  includeClusterResources?: boolean | undefined;
  includedClusterScopedResources?: readonly string[] | undefined;
}

/**
 * What a backup request reaches, for the namespace-scoping rule of PLAN.md §8.2.
 *
 *  - No included namespaces, or `*`, means **all of them**.
 *  - Exclude lists never narrow it: "everything except prod" still reaches everything else.
 *  - It includes cluster-scoped resources unless `includeClusterResources` is explicitly
 *    `false`. Velero's default ("auto") adds the cluster-scoped objects the selected
 *    resources need, which is cluster scope for this purpose: a scoped user must say
 *    `false`. (Reading is looser — see ADR-024 — because there it only decides visibility.)
 *  - Any cluster-scoped resource named in `includedClusterScopedResources` counts, whatever
 *    `includeClusterResources` says.
 */
export function createCoverage(input: CoverageInput): Coverage {
  const included = input.includedNamespaces ?? [];
  const everything = included.length === 0 || included.includes('*');
  return {
    namespaces: everything ? ['*'] : [...included],
    includesClusterScoped:
      input.includeClusterResources !== false ||
      (input.includedClusterScopedResources?.length ?? 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// What the agent receives.

/** Seconds in a Go-style duration, or `undefined` when it is zero. */
export function durationSeconds(text: string): { seconds: number; nanos: number } | undefined {
  const units: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(match[1]) * (units[match[2] ?? 's'] ?? 0);
  }
  if (total <= 0) {
    return undefined;
  }
  const seconds = Math.floor(total);
  return { seconds, nanos: Math.round((total - seconds) * 1e9) };
}

export const MAX_TTL_SECONDS = 10 * 365 * 24 * 3600;

/** Whether the durations in a body are in range; a message when not. */
export function checkDurations(body: CreateBackupBody): string | undefined {
  for (const key of ['ttl', 'itemOperationTimeout', 'csiSnapshotTimeout'] as const) {
    const text = body[key];
    if (text === undefined) {
      continue;
    }
    const d = durationSeconds(text);
    if (d === undefined) {
      return `${key} must be greater than zero`;
    }
    if (d.seconds > MAX_TTL_SECONDS) {
      return `${key} is longer than ten years`;
    }
  }
  return undefined;
}

export const selectorProto = (s: z.infer<typeof selector>) => ({
  matchLabels: s.matchLabels ?? {},
  matchExpressions: (s.matchExpressions ?? []).map((e) => ({
    key: e.key,
    operator: e.operator,
    values: e.values ?? [],
  })),
});

/** The protobuf spec for a validated body. */
export function toBackupSpec(body: CreateBackupBody): BackupSpec {
  return {
    metadataLabels: body.metadataLabels ?? {},
    includedNamespaces: body.includedNamespaces ?? [],
    excludedNamespaces: body.excludedNamespaces ?? [],
    includedResources: body.includedResources ?? [],
    excludedResources: body.excludedResources ?? [],
    includedClusterScopedResources: body.includedClusterScopedResources ?? [],
    excludedClusterScopedResources: body.excludedClusterScopedResources ?? [],
    includedNamespaceScopedResources: body.includedNamespaceScopedResources ?? [],
    excludedNamespaceScopedResources: body.excludedNamespaceScopedResources ?? [],
    labelSelector: body.labelSelector === undefined ? undefined : selectorProto(body.labelSelector),
    orLabelSelectors: (body.orLabelSelectors ?? []).map(selectorProto),
    snapshotVolumes: body.snapshotVolumes,
    ttl: body.ttl === undefined ? undefined : durationSeconds(body.ttl),
    volumeGroupSnapshotLabelKey: body.volumeGroupSnapshotLabelKey ?? '',
    includeClusterResources: body.includeClusterResources,
    hooks: undefined,
    storageLocation: body.storageLocation ?? '',
    volumeSnapshotLocations: body.volumeSnapshotLocations ?? [],
    defaultVolumesToFsBackup: body.defaultVolumesToFsBackup,
    orderedResources: body.orderedResources ?? {},
    csiSnapshotTimeout:
      body.csiSnapshotTimeout === undefined ? undefined : durationSeconds(body.csiSnapshotTimeout),
    itemOperationTimeout:
      body.itemOperationTimeout === undefined
        ? undefined
        : durationSeconds(body.itemOperationTimeout),
    resourcePolicy:
      body.resourcePolicy === undefined
        ? undefined
        : { apiGroup: '', kind: 'ConfigMap', name: body.resourcePolicy },
    snapshotMoveData: body.snapshotMoveData,
    dataMover: body.dataMover ?? '',
    uploaderConfig:
      body.parallelFilesUpload === undefined
        ? undefined
        : { parallelFilesUpload: body.parallelFilesUpload },
  };
}

/** The `Command` arm for a stored `CREATE_BACKUP` payload. Re-validates: the row is data, not trust. */
export function buildCreateBackup(payload: Record<string, unknown>): Partial<Command> {
  const body = createBackupBody.parse(payload);
  return {
    createBackup: {
      name: body.name ?? '',
      spec: toBackupSpec(body),
      advancedSpecJson:
        body.advancedSpec === undefined
          ? new Uint8Array()
          : Buffer.from(JSON.stringify(body.advancedSpec)),
    },
  };
}
