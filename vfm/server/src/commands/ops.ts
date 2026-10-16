import { buildCreateBackup } from '../backups/backup-request';
import { DEFAULT_MAX_BYTES, partByKey } from '../downloads/parts';
import type { Command } from '../gateway/pb/vfm/agent/v1/command';

/**
 * The operations the control plane can send, and how each becomes a protobuf
 * `Command` (PLAN.md §5.2). One entry per operation keeps the set closed: a
 * caller cannot enqueue an op that is not listed here, and the agent applies the
 * same rule on its side (typed commands only, PLAN.md §1.1 P3).
 *
 * `REFRESH_STATUS`, `FETCH_DOWNLOAD` and the backup operations are the entries so far. The M4 mutations (backups, restores,
 * schedules, storage locations) are added here with their own validation.
 */
export interface OpDefinition {
  /** Default deadline: a command still non-terminal after this is `TIMED_OUT`. */
  timeoutMs: number;
  /** Builds the oneof arm of the protobuf `Command`. */
  build: (payload: Record<string, unknown>) => Partial<Command>;
}

const DEFINITIONS = {
  REFRESH_STATUS: {
    timeoutMs: 60_000,
    build: () => ({ refreshStatus: {} }),
  },
  /** `velero backup create` (PLAN.md §6); the payload is the validated API body. */
  CREATE_BACKUP: { timeoutMs: 60_000, build: buildCreateBackup },
  /** Deletes through a `DeleteBackupRequest`, so the data in storage goes too. */
  DELETE_BACKUP: {
    timeoutMs: 60_000,
    build: (payload) => ({ deleteBackup: { name: String(payload.name) } }),
  },
  /** `velero backup create --from-schedule`. */
  TRIGGER_SCHEDULE: {
    timeoutMs: 60_000,
    build: (payload) => ({
      triggerSchedule: {
        scheduleName: String(payload.scheduleName),
        backupName: typeof payload.backupName === 'string' ? payload.backupName : '',
      },
    }),
  },
  /** Fetch one of Velero's files for a backup or restore (PLAN.md §7.3); see `downloads/`. */
  FETCH_DOWNLOAD: {
    timeoutMs: 120_000,
    build: (payload) => {
      const part = partByKey(String(payload.part));
      if (part === undefined) {
        throw new Error('unknown download part');
      }
      return {
        fetchDownload: {
          targetKind: part.target,
          targetName: String(payload.targetName),
          maxBytes: typeof payload.maxBytes === 'number' ? payload.maxBytes : DEFAULT_MAX_BYTES,
        },
      };
    },
  },
} as const satisfies Record<string, OpDefinition>;

export type OpKey = keyof typeof DEFINITIONS;

/** Widened so every entry is called through the same `build(payload)` signature. */
export const OPS: Record<OpKey, OpDefinition> = DEFINITIONS;

export const isOp = (value: string): value is OpKey => Object.hasOwn(OPS, value);
