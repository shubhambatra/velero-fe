import type { Command } from '../gateway/pb/vfm/agent/v1/command';

/**
 * The operations the control plane can send, and how each becomes a protobuf
 * `Command` (PLAN.md §5.2). One entry per operation keeps the set closed: a
 * caller cannot enqueue an op that is not listed here, and the agent applies the
 * same rule on its side (typed commands only, PLAN.md §1.1 P3).
 *
 * `REFRESH_STATUS` is the only entry in M2. The M4 mutations (backups, restores,
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
} as const satisfies Record<string, OpDefinition>;

export type OpKey = keyof typeof DEFINITIONS;

/** Widened so every entry is called through the same `build(payload)` signature. */
export const OPS: Record<OpKey, OpDefinition> = DEFINITIONS;

export const isOp = (value: string): value is OpKey => Object.hasOwn(OPS, value);
