import type { CommandStatus } from '@prisma/client';

/**
 * The command lifecycle of PLAN.md §5.4:
 *
 * ```
 * QUEUED ─► SENT ─► ACKED ─► RUNNING ─► SUCCEEDED
 *    │        │        │          └────► FAILED
 *    │        └────────┴──► (reconnect) re-SENT
 *    └──► CANCELLED (by user before ACK)
 * any non-terminal ──► TIMED_OUT
 * ```
 *
 * A pure function so every rule can be tested without a database, and so the
 * service can turn each transition into one conditional `UPDATE`.
 */
export type CommandEvent =
  'sent' | 'acked' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export const TERMINAL: ReadonlySet<CommandStatus> = new Set<CommandStatus>([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

export const NON_TERMINAL: readonly CommandStatus[] = ['QUEUED', 'SENT', 'ACKED', 'RUNNING'];

/**
 * The status after `event`, or `null` when the event must be ignored.
 *
 * Messages arrive late, twice and out of order (a result can beat its ack; a
 * re-delivered command is acked again), so the rule is: **never move backwards
 * and never leave a terminal state.** An ignored event is not an error.
 */
export function transition(current: CommandStatus, event: CommandEvent): CommandStatus | null {
  if (TERMINAL.has(current)) {
    return null;
  }
  switch (event) {
    case 'sent':
      // A re-send of something already acknowledged does not regress it.
      return current === 'QUEUED' ? 'SENT' : current;
    case 'acked':
      return current === 'QUEUED' || current === 'SENT' ? 'ACKED' : current;
    case 'running':
      return 'RUNNING';
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      // Only before the agent has taken it: afterwards it may already be acting.
      return current === 'QUEUED' || current === 'SENT' ? 'CANCELLED' : null;
    case 'timed_out':
      return 'TIMED_OUT';
  }
}

/** The statuses from which `event` is accepted, for a conditional UPDATE. */
export function statusesAccepting(event: CommandEvent): CommandStatus[] {
  return NON_TERMINAL.filter((status) => {
    const next = transition(status, event);
    return next !== null;
  });
}
