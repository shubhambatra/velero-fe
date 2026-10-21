import { describe, expect, it } from 'vitest';

import {
  agentDisconnected,
  backupExpiring,
  backupFailed,
  bslUnavailable,
  scheduleMissed,
  type BackupRow,
  type ClusterFacts,
  type ScheduleRow,
} from './conditions';

const NOW = new Date('2026-10-17T12:00:00Z');
const ago = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);
const ahead = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);

const backup = (over: Partial<BackupRow> & { name: string }): BackupRow => ({
  namespace: 'velero',
  phase: 'Completed',
  schedule: null,
  at: ago(1),
  expiresAt: ahead(30),
  failureReason: null,
  ...over,
});
const schedule = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  name: 'nightly',
  namespace: 'velero',
  cron: '0 2 * * *',
  paused: false,
  createdAt: ago(24 * 30),
  lastBackupAt: null,
  ...over,
});
const facts = (over: Partial<ClusterFacts> = {}): ClusterFacts => ({
  id: 'c1',
  name: 'prod',
  status: 'CONNECTED',
  lastSeenAt: NOW,
  backups: [],
  schedules: [],
  locations: [],
  ...over,
});

describe('backupFailed', () => {
  const params = { lookbackHours: 24, includePartiallyFailed: true };

  it('fires for a failed backup inside the window, naming it', () => {
    const out = backupFailed(
      facts({ backups: [backup({ name: 'b1', phase: 'Failed', failureReason: 'bsl down' })] }),
      params,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.fingerprint).toBe('backup-failed:velero/b1');
    expect(out[0]?.payload).toMatchObject({ cluster: 'prod', backup: 'b1', reason: 'bsl down' });
  });

  it.each([
    ['PartiallyFailed', true, 1],
    ['PartiallyFailed', false, 0],
    ['FailedValidation', false, 1],
    ['Completed', true, 0],
    ['InProgress', true, 0],
  ])('%s with partial=%s gives %i', (phase, partial, count) => {
    const out = backupFailed(
      facts({ backups: [backup({ name: 'b', phase })] }),
      { ...params, includePartiallyFailed: partial },
      NOW,
    );
    expect(out).toHaveLength(count);
  });

  it('leaves a failure older than the window alone', () => {
    expect(
      backupFailed(
        facts({ backups: [backup({ name: 'old', phase: 'Failed', at: ago(30) })] }),
        params,
        NOW,
      ),
    ).toEqual([]);
  });

  it('is one condition for a schedule however many of its runs failed, and the latest is named', () => {
    const out = backupFailed(
      facts({
        backups: [
          backup({ name: 'n-1', phase: 'Failed', schedule: 'nightly', at: ago(5) }),
          backup({ name: 'n-2', phase: 'Failed', schedule: 'nightly', at: ago(2) }),
        ],
      }),
      params,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.payload.backup).toBe('n-2');
  });

  it('is fixed by a later completed backup of the same schedule, not by an earlier or other one', () => {
    const failed = backup({ name: 'f', phase: 'Failed', schedule: 'nightly', at: ago(3) });
    const later = backup({ name: 'ok', schedule: 'nightly', at: ago(1) });
    const earlier = backup({ name: 'before', schedule: 'nightly', at: ago(6) });
    const other = backup({ name: 'other', schedule: 'weekly', at: ago(1) });
    expect(backupFailed(facts({ backups: [failed, later] }), params, NOW)).toEqual([]);
    expect(backupFailed(facts({ backups: [failed, earlier] }), params, NOW)).toHaveLength(1);
    expect(backupFailed(facts({ backups: [failed, other] }), params, NOW)).toHaveLength(1);
  });

  it('ignores a backup with no time at all', () => {
    expect(
      backupFailed(
        facts({ backups: [backup({ name: 'x', phase: 'Failed', at: null })] }),
        params,
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('scheduleMissed', () => {
  it('fires when no backup came within 1.5 intervals', () => {
    const out = scheduleMissed(
      facts({
        schedules: [schedule()],
        backups: [backup({ name: 'old', schedule: 'nightly', at: ago(40) })],
      }),
      { factor: 1.5 },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.fingerprint).toBe('schedule-missed:velero/nightly');
    expect(out[0]?.payload.allowedHours).toBe(36);
  });

  it('is quiet inside the allowance, and at its edge', () => {
    const at = (h: number) =>
      scheduleMissed(
        facts({
          schedules: [schedule()],
          backups: [backup({ name: 'b', schedule: 'nightly', at: ago(h) })],
        }),
        { factor: 1.5 },
        NOW,
      );
    expect(at(35)).toEqual([]);
    expect(at(36)).toEqual([]);
    expect(at(36.1)).toHaveLength(1);
  });

  it('counts any phase as a run, so a failing schedule is a failure alert, not a missed one', () => {
    const out = scheduleMissed(
      facts({
        schedules: [schedule()],
        backups: [backup({ name: 'b', phase: 'Failed', schedule: 'nightly', at: ago(2) })],
      }),
      { factor: 1.5 },
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('uses the schedule’s own last-backup time when the backups are gone', () => {
    const out = scheduleMissed(
      facts({ schedules: [schedule({ lastBackupAt: ago(3) })] }),
      { factor: 1.5 },
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('gives a new schedule time before it is late', () => {
    expect(
      scheduleMissed(facts({ schedules: [schedule({ createdAt: ago(5) })] }), { factor: 1.5 }, NOW),
    ).toEqual([]);
    expect(
      scheduleMissed(
        facts({ schedules: [schedule({ createdAt: ago(40) })] }),
        { factor: 1.5 },
        NOW,
      ),
    ).toHaveLength(1);
  });

  it('skips paused schedules, unreadable cron and ones that never run', () => {
    const stale = { createdAt: ago(24 * 90) };
    expect(
      scheduleMissed(
        facts({ schedules: [schedule({ paused: true, ...stale })] }),
        { factor: 1.5 },
        NOW,
      ),
    ).toEqual([]);
    expect(
      scheduleMissed(
        facts({ schedules: [schedule({ cron: 'nonsense', ...stale })] }),
        { factor: 1.5 },
        NOW,
      ),
    ).toEqual([]);
    expect(
      scheduleMissed(
        facts({ schedules: [schedule({ cron: '0 0 31 2 *', ...stale })] }),
        { factor: 1.5 },
        NOW,
      ),
    ).toEqual([]);
    expect(
      scheduleMissed(
        facts({ schedules: [schedule({ cron: null, ...stale })] }),
        { factor: 1.5 },
        NOW,
      ),
    ).toEqual([]);
  });

  it('does not call a weekdays-only schedule late over the weekend', () => {
    // Saturday noon; last run was Friday 02:00, 34 hours ago; the longest gap is 72 h.
    const sat = new Date('2026-10-17T12:00:00Z');
    const out = scheduleMissed(
      facts({
        schedules: [schedule({ cron: '0 2 * * 1-5', createdAt: new Date('2026-09-01T00:00:00Z') })],
        backups: [
          backup({ name: 'fri', schedule: 'nightly', at: new Date('2026-10-16T02:00:00Z') }),
        ],
      }),
      { factor: 1.5 },
      sat,
    );
    expect(out).toEqual([]);
  });

  it('does not mix up schedules of the same name in different namespaces', () => {
    const out = scheduleMissed(
      facts({
        schedules: [schedule({ namespace: 'other', createdAt: ago(100) })],
        backups: [backup({ name: 'b', namespace: 'velero', schedule: 'nightly', at: ago(1) })],
      }),
      { factor: 1.5 },
      NOW,
    );
    expect(out).toHaveLength(1);
  });
});

describe('agentDisconnected', () => {
  const params = { minutes: 10 };

  it('fires once the agent has been away for the time given', () => {
    const at = (min: number) =>
      agentDisconnected(
        facts({ status: 'DISCONNECTED', lastSeenAt: new Date(NOW.getTime() - min * 60_000) }),
        params,
        NOW,
      );
    expect(at(9)).toEqual([]);
    expect(at(10)).toHaveLength(1);
    expect(at(10)[0]?.payload).toMatchObject({ cluster: 'prod', minutes: 10 });
  });

  it.each(['PENDING', 'DISABLED', 'CONNECTED'])('is quiet for a %s cluster', (status) => {
    expect(agentDisconnected(facts({ status, lastSeenAt: ago(5) }), params, NOW)).toEqual([]);
  });

  it('is quiet for an agent that never connected', () => {
    expect(agentDisconnected(facts({ status: 'ENROLLED', lastSeenAt: null }), params, NOW)).toEqual(
      [],
    );
  });
});

describe('bslUnavailable', () => {
  it('names each unavailable location and no other', () => {
    const out = bslUnavailable(
      facts({
        locations: [
          { name: 'default', namespace: 'velero', phase: 'Unavailable' },
          { name: 'second', namespace: 'velero', phase: 'Available' },
          { name: 'third', namespace: 'velero', phase: null },
        ],
      }),
    );
    expect(out.map((c) => c.fingerprint)).toEqual(['bsl-unavailable:velero/default']);
  });
});

describe('backupExpiring', () => {
  const params = { withinDays: 3 };

  it('fires when the newest backup expires within the window and nothing newer exists', () => {
    const out = backupExpiring(
      facts({ backups: [backup({ name: 'b', expiresAt: ahead(2) })] }),
      params,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.payload).toMatchObject({ backup: 'b', expired: false });
  });

  it('is quiet when a newer backup of the same schedule exists, or the expiry is far off', () => {
    const old = backup({ name: 'old', schedule: 's', at: ago(48), expiresAt: ahead(1) });
    const fresh = backup({ name: 'new', schedule: 's', at: ago(1), expiresAt: ahead(30) });
    expect(backupExpiring(facts({ backups: [old, fresh] }), params, NOW)).toEqual([]);
    expect(
      backupExpiring(facts({ backups: [backup({ name: 'b', expiresAt: ahead(4) })] }), params, NOW),
    ).toEqual([]);
  });

  it('says so when it has already expired, and ignores backups that did not complete', () => {
    const out = backupExpiring(
      facts({ backups: [backup({ name: 'b', expiresAt: ago(2) })] }),
      params,
      NOW,
    );
    expect(out[0]?.payload.expired).toBe(true);
    expect(
      backupExpiring(
        facts({ backups: [backup({ name: 'f', phase: 'Failed', expiresAt: ahead(1) })] }),
        params,
        NOW,
      ),
    ).toEqual([]);
  });

  it('ignores a backup with no expiry', () => {
    expect(
      backupExpiring(facts({ backups: [backup({ name: 'b', expiresAt: null })] }), params, NOW),
    ).toEqual([]);
  });
});
