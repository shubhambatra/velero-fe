import type { CommandStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  NON_TERMINAL,
  statusesAccepting,
  TERMINAL,
  transition,
  type CommandEvent,
} from './command-state';

const ALL: CommandStatus[] = [...NON_TERMINAL, ...TERMINAL];
const EVENTS: CommandEvent[] = [
  'sent',
  'acked',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'approved',
  'rejected',
];

describe('command state machine', () => {
  it('never leaves a terminal state', () => {
    for (const status of TERMINAL) {
      for (const event of EVENTS) {
        expect(transition(status, event), `${status} + ${event}`).toBeNull();
      }
    }
  });

  it('follows the happy path in order', () => {
    expect(transition('QUEUED', 'sent')).toBe('SENT');
    expect(transition('SENT', 'acked')).toBe('ACKED');
    expect(transition('ACKED', 'running')).toBe('RUNNING');
    expect(transition('RUNNING', 'succeeded')).toBe('SUCCEEDED');
  });

  it('never moves backwards, whatever order messages arrive in', () => {
    const rank: Record<CommandStatus, number> = {
      PENDING_APPROVAL: -1,
      REJECTED: 4,
      QUEUED: 0,
      SENT: 1,
      ACKED: 2,
      RUNNING: 3,
      SUCCEEDED: 4,
      FAILED: 4,
      CANCELLED: 4,
      TIMED_OUT: 4,
    };
    for (const status of NON_TERMINAL) {
      for (const event of EVENTS) {
        const next = transition(status, event);
        if (next !== null) {
          expect(rank[next], `${status} + ${event} -> ${next}`).toBeGreaterThanOrEqual(
            rank[status],
          );
        }
      }
    }
  });

  it('lets a result arrive without its ack, and an ack arrive twice', () => {
    expect(transition('SENT', 'succeeded')).toBe('SUCCEEDED');
    expect(transition('QUEUED', 'failed')).toBe('FAILED');
    expect(transition('ACKED', 'acked')).toBe('ACKED');
    expect(transition('RUNNING', 'acked')).toBe('RUNNING');
    expect(transition('RUNNING', 'sent')).toBe('RUNNING');
  });

  it('allows cancelling only before the agent has taken the command', () => {
    expect(transition('QUEUED', 'cancelled')).toBe('CANCELLED');
    expect(transition('SENT', 'cancelled')).toBe('CANCELLED');
    expect(transition('ACKED', 'cancelled')).toBeNull();
    expect(transition('RUNNING', 'cancelled')).toBeNull();
  });

  it('times out from every non-terminal state', () => {
    for (const status of NON_TERMINAL) {
      expect(transition(status, 'timed_out')).toBe('TIMED_OUT');
    }
  });

  it('knows which statuses accept an event, for conditional updates', () => {
    expect(statusesAccepting('cancelled')).toEqual(['QUEUED', 'SENT']);
    expect(statusesAccepting('succeeded')).toEqual(NON_TERMINAL);
    expect(statusesAccepting('running')).toEqual(NON_TERMINAL);
    for (const status of ALL) {
      if (TERMINAL.has(status)) {
        for (const event of EVENTS) {
          expect(statusesAccepting(event)).not.toContain(status);
        }
      }
    }
  });

  describe('a restore waiting for approval', () => {
    it('can be approved into the queue, rejected, withdrawn or timed out, and nothing else', () => {
      expect(transition('PENDING_APPROVAL', 'approved')).toBe('QUEUED');
      expect(transition('PENDING_APPROVAL', 'rejected')).toBe('REJECTED');
      expect(transition('PENDING_APPROVAL', 'cancelled')).toBe('CANCELLED');
      expect(transition('PENDING_APPROVAL', 'timed_out')).toBe('TIMED_OUT');
      for (const event of ['sent', 'acked', 'running', 'succeeded', 'failed'] as const) {
        expect(transition('PENDING_APPROVAL', event), event).toBeNull();
      }
    });

    it('is not something that can be approved or rejected once the agent has it', () => {
      for (const status of NON_TERMINAL) {
        expect(transition(status, 'approved'), status).toBeNull();
        expect(transition(status, 'rejected'), status).toBeNull();
      }
    });

    it('is not in flight: not delivered, not counted, not accepted by agent events', () => {
      expect(NON_TERMINAL).not.toContain('PENDING_APPROVAL');
      for (const event of EVENTS) {
        expect(statusesAccepting(event)).not.toContain('PENDING_APPROVAL');
      }
    });

    it('leaves a rejected request rejected', () => {
      expect(TERMINAL.has('REJECTED')).toBe(true);
      for (const event of EVENTS) {
        expect(transition('REJECTED', event), event).toBeNull();
      }
    });
  });
});
