import { restoreNamespaces } from '@vfm/shared';
import { z } from 'zod';

import {
  duration,
  durationSeconds,
  labelMap,
  MAX_TTL_SECONDS,
  names,
  namespace,
  OBJECT_NAME,
  resource,
  selector,
  selectorProto,
  type Coverage,
} from '../backups/backup-request';
import type { Command } from '../gateway/pb/vfm/agent/v1/command';
import { ExistingResourcePolicy, type RestoreSpec } from '../gateway/pb/vfm/agent/v1/velero';

/**
 * The API body of `POST …/restores` and how it becomes (a) a decision about who may make
 * it and (b) the protobuf the agent receives (PLAN.md §6, §8.2).
 *
 * Like the backup body it is **strict**, and it names exactly one source. Restore hooks
 * run commands inside workloads (and init hooks add containers), so they are not a typed
 * field: they go through `advancedSpec`, which needs `advanced:write` on the whole cluster.
 */

const nsMapping = z
  .record(
    namespace.refine((n) => n !== '*', 'a namespace name'),
    namespace.refine((n) => n !== '*', 'a namespace name'),
  )
  .refine((m) => Object.keys(m).length <= 100, 'at most 100 mappings');

export const createRestoreBody = z
  .object({
    /** Empty: the agent generates `<source>-<timestamp>` like the CLI. */
    name: z.string().max(63).regex(OBJECT_NAME).optional(),
    backupName: z.string().max(63).regex(OBJECT_NAME).optional(),
    scheduleName: z.string().max(63).regex(OBJECT_NAME).optional(),
    includedNamespaces: names(namespace).optional(),
    excludedNamespaces: names(namespace).optional(),
    includedResources: names(resource).optional(),
    excludedResources: names(resource).optional(),
    namespaceMapping: nsMapping.optional(),
    labelSelector: selector.optional(),
    orLabelSelectors: z.array(selector).max(20).optional(),
    restorePVs: z.boolean().optional(),
    restoreStatus: z
      .object({
        includedResources: names(resource).optional(),
        excludedResources: names(resource).optional(),
      })
      .strict()
      .optional(),
    preserveNodePorts: z.boolean().optional(),
    includeClusterResources: z.boolean().optional(),
    existingResourcePolicy: z.enum(['none', 'update']).optional(),
    itemOperationTimeout: duration.optional(),
    /** The name of a ConfigMap holding resource modifier rules. */
    resourceModifier: z.string().max(253).regex(OBJECT_NAME).optional(),
    writeSparseFiles: z.boolean().optional(),
    parallelFilesDownload: z.number().int().min(1).max(64).optional(),
    metadataLabels: labelMap.optional(),
    advancedSpec: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((b) => (b.backupName === undefined) !== (b.scheduleName === undefined), {
    message: 'name exactly one of backupName and scheduleName',
    path: ['backupName'],
  });

export type CreateRestoreBody = z.infer<typeof createRestoreBody>;

// ---------------------------------------------------------------------------
// Who may make it.

/**
 * What a restore request reaches, for the namespace-scoping rule of PLAN.md §8.2.
 *
 *  - No included namespaces, or `*`, means **all of them**.
 *  - **Both** sides of a mapping count: the source (whose data is read) and the target
 *    (where it is written). Checking only the target would let a user scoped to `dev`
 *    restore `prod`'s data into `dev` and read it there.
 *  - It includes cluster-scoped resources unless `includeClusterResources` is explicitly
 *    `false` (Velero's default adds what the selected resources need); same rule as a backup.
 */
export function restoreCoverage(body: {
  includedNamespaces?: readonly string[] | undefined;
  namespaceMapping?: Readonly<Record<string, string>> | undefined;
  includeClusterResources?: boolean | undefined;
}): Coverage {
  const included = body.includedNamespaces ?? [];
  const everything = included.length === 0 || included.includes('*');
  return {
    namespaces: everything ? ['*'] : restoreNamespaces(included, body.namespaceMapping ?? {}),
    includesClusterScoped: body.includeClusterResources !== false,
  };
}

/** A message when a duration is out of range. */
export function checkRestoreDurations(body: CreateRestoreBody): string | undefined {
  if (body.itemOperationTimeout === undefined) {
    return undefined;
  }
  const d = durationSeconds(body.itemOperationTimeout);
  if (d === undefined) {
    return 'itemOperationTimeout must be greater than zero';
  }
  return d.seconds > MAX_TTL_SECONDS ? 'itemOperationTimeout is longer than ten years' : undefined;
}

// ---------------------------------------------------------------------------
// What the agent receives.

export function toRestoreSpec(body: CreateRestoreBody): RestoreSpec {
  const hasUploader =
    body.writeSparseFiles !== undefined || body.parallelFilesDownload !== undefined;
  return {
    backupName: body.backupName ?? '',
    scheduleName: body.scheduleName ?? '',
    includedNamespaces: body.includedNamespaces ?? [],
    excludedNamespaces: body.excludedNamespaces ?? [],
    includedResources: body.includedResources ?? [],
    excludedResources: body.excludedResources ?? [],
    namespaceMapping: body.namespaceMapping ?? {},
    labelSelector: body.labelSelector === undefined ? undefined : selectorProto(body.labelSelector),
    orLabelSelectors: (body.orLabelSelectors ?? []).map(selectorProto),
    restorePvs: body.restorePVs,
    restoreStatus:
      body.restoreStatus === undefined
        ? undefined
        : {
            includedResources: body.restoreStatus.includedResources ?? [],
            excludedResources: body.restoreStatus.excludedResources ?? [],
          },
    preserveNodePorts: body.preserveNodePorts,
    includeClusterResources: body.includeClusterResources,
    hooks: undefined,
    existingResourcePolicy:
      body.existingResourcePolicy === 'none'
        ? ExistingResourcePolicy.EXISTING_RESOURCE_POLICY_NONE
        : body.existingResourcePolicy === 'update'
          ? ExistingResourcePolicy.EXISTING_RESOURCE_POLICY_UPDATE
          : ExistingResourcePolicy.EXISTING_RESOURCE_POLICY_UNSPECIFIED,
    itemOperationTimeout:
      body.itemOperationTimeout === undefined
        ? undefined
        : durationSeconds(body.itemOperationTimeout),
    resourceModifier:
      body.resourceModifier === undefined
        ? undefined
        : { apiGroup: '', kind: 'ConfigMap', name: body.resourceModifier },
    resourcePolicy: undefined,
    uploaderConfig: hasUploader
      ? {
          writeSparseFiles: body.writeSparseFiles,
          parallelFilesDownload: body.parallelFilesDownload ?? 0,
        }
      : undefined,
  };
}

/** The `Command` arm for a stored `CREATE_RESTORE` payload. Re-validates: the row is data, not trust. */
export function buildCreateRestore(payload: Record<string, unknown>): Partial<Command> {
  const body = createRestoreBody.parse(payload);
  return {
    createRestore: {
      name: body.name ?? '',
      spec: toRestoreSpec(body),
      advancedSpecJson:
        body.advancedSpec === undefined
          ? new Uint8Array()
          : Buffer.from(JSON.stringify(body.advancedSpec)),
    },
  };
}
