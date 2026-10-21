import { describe, expect, it } from 'vitest';

import {
  bucketStart,
  rpoCompliance,
  staleNamespaces,
  successRate,
  sumSeries,
  totals,
  type FinishedBackup,
} from './calculations';

const t = (s: string): Date => new Date(s.endsWith('Z') ? s : `${s}Z`);
const H = 3_600_000;

describe('bucketStart', () => {
  it('is the UTC day', () => {
    expect(bucketStart(t('2026-10-17T23:59:59'), 'day').toISOString()).toBe(
      '2026-10-17T00:00:00.000Z',
    );
  });
  it('is the Monday of the week, including on Sunday and on Monday itself', () => {
    expect(bucketStart(t('2026-10-17T12:00'), 'week').toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    ); // Saturday
    expect(bucketStart(t('2026-10-18T12:00'), 'week').toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    ); // Sunday
    expect(bucketStart(t('2026-10-12T00:00'), 'week').toISOString()).toBe(
      '2026-10-12T00:00:00.000Z',
    ); // Monday
    expect(bucketStart(t('2026-10-11T23:59'), 'week').toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
  });
  it('crosses a month and a year', () => {
    expect(bucketStart(t('2026-01-01T10:00'), 'week').toISOString()).toBe(
      '2025-12-29T00:00:00.000Z',
    );
  });
});

describe('successRate', () => {
  const b = (phase: string | null, at: string): FinishedBackup => ({
    clusterId: 'c',
    phase,
    at: t(at),
  });

  it('counts each outcome in its day and works out the rate by hand', () => {
    const points = successRate(
      [
        b('Completed', '2026-10-10T02:00'),
        b('Completed', '2026-10-10T14:00'),
        b('Failed', '2026-10-10T20:00'),
        b('PartiallyFailed', '2026-10-10T21:00'),
        b('FailedValidation', '2026-10-12T01:00'),
        b('Completed', '2026-10-12T02:00'),
      ],
      t('2026-10-10T00:00'),
      t('2026-10-13T00:00'),
      'day',
    );
    expect(
      points.map((p) => [p.start.slice(0, 10), p.completed, p.partiallyFailed, p.failed, p.rate]),
    ).toEqual([
      ['2026-10-10', 2, 1, 1, 0.5],
      ['2026-10-11', 0, 0, 0, null],
      ['2026-10-12', 1, 0, 1, 0.5],
    ]);
    expect(totals(points)).toEqual({ completed: 3, partiallyFailed: 1, failed: 2, rate: 0.5 });
  });

  it('ignores backups that have not finished, unknown phases, and anything outside the window', () => {
    const points = successRate(
      [
        b('InProgress', '2026-10-10T02:00'),
        b('New', '2026-10-10T02:00'),
        b(null, '2026-10-10T02:00'),
        b('Completed', '2026-10-09T23:59:59'),
        b('Completed', '2026-10-11T00:00'), // the end is exclusive
        b('Completed', '2026-10-10T00:00'), // the start is inclusive
      ],
      t('2026-10-10T00:00'),
      t('2026-10-11T00:00'),
      'day',
    );
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ completed: 1, partiallyFailed: 0, failed: 0, rate: 1 });
  });

  it('makes weekly buckets from Monday, covering a window that starts mid-week', () => {
    const points = successRate(
      [
        b('Completed', '2026-10-14T01:00'),
        b('Failed', '2026-10-20T01:00'),
        b('Completed', '2026-10-21T01:00'),
      ],
      t('2026-10-14T00:00'),
      t('2026-10-25T00:00'),
      'week',
    );
    expect(points.map((p) => [p.start.slice(0, 10), p.completed, p.failed])).toEqual([
      ['2026-10-12', 1, 0],
      ['2026-10-19', 1, 1],
    ]);
  });

  it('is all empty, with null rates, when nothing finished', () => {
    const points = successRate([], t('2026-10-10T00:00'), t('2026-10-12T00:00'), 'day');
    expect(points.map((p) => p.rate)).toEqual([null, null]);
    expect(totals(points).rate).toBeNull();
  });

  it('adds clusters bucket by bucket', () => {
    const from = t('2026-10-10T00:00');
    const to = t('2026-10-12T00:00');
    const a = successRate(
      [b('Completed', '2026-10-10T01:00'), b('Failed', '2026-10-11T01:00')],
      from,
      to,
      'day',
    );
    const c = successRate(
      [b('Completed', '2026-10-10T01:00'), b('Completed', '2026-10-11T01:00')],
      from,
      to,
      'day',
    );
    const sum = sumSeries([a, c]);
    expect(sum.map((p) => [p.completed, p.failed, p.rate])).toEqual([
      [2, 0, 1],
      [1, 1, 0.5],
    ]);
    expect(sumSeries([])).toEqual([]);
  });
});

describe('rpoCompliance', () => {
  const T = 36 * H;
  const to = t('2026-10-11T00:00');

  it('is 100 % when a backup lands within the objective every time', () => {
    // Daily at 02:00 from 1 to 10 October; window from 2 October 00:00 to 11 October 00:00; objective 36 h.
    const days = Array.from({ length: 10 }, (_, i) =>
      t(`2026-10-${String(i + 1).padStart(2, '0')}T02:00`),
    );
    const r = rpoCompliance(days, t('2026-10-02T00:00'), to, T, t('2026-09-01T00:00'));
    expect(r.compliance).toBe(1);
    expect(r.successes).toBe(9);
    expect(r.longestGapHours).toBe(24);
    expect(r.ageHours).toBe(22);
  });

  it('counts the time past the objective after a missed backup, by hand', () => {
    // Window 10 days. Successes on day 1 02:00 and day 5 02:00 (a 96 h gap) and day 6 02:00.
    // Gap 1: starts at the window start (day 1 00:00)? Anchor is a success at day 1 02:00 before the
    // start, so build the window to start at day 1 02:00 exactly to make the sums plain.
    const start = t('2026-10-01T02:00');
    const s = [t('2026-10-01T02:00'), t('2026-10-05T02:00'), t('2026-10-06T02:00')];
    const end = t('2026-10-07T02:00');
    const r = rpoCompliance(s, start, end, T, t('2026-09-01T00:00'));
    // Segments: 96 h (36 ok, 60 not), 24 h (24 ok), 24 h to the end (24 ok). Total 144 h, ok 84 h.
    expect(r.measuredHours).toBe(144);
    expect(r.compliantHours).toBe(84);
    expect(r.compliance).toBeCloseTo(84 / 144, 10);
    expect(r.longestGapHours).toBe(96);
    expect(r.successes).toBe(2);
    expect(r.metNow).toBe(true);
    expect(r.ageHours).toBe(24);
    expect(r.lastSuccessAt).toBe('2026-10-06T02:00:00.000Z');
  });

  it('starts counting from the age the newest backup already has at the start of the window', () => {
    // Last success 30 h before the window; objective 36 h: compliant for the first 6 h only, until the next success.
    const r = rpoCompliance(
      [t('2026-10-09T18:00'), t('2026-10-10T12:00')],
      t('2026-10-10T00:00'),
      t('2026-10-10T12:00'),
      T,
      t('2026-09-01T00:00'),
    );
    // Segment a=Oct 9 18:00 .. b=Oct 10 12:00, measured from the start: 12 h, compliant while age <= 36 h: all 12 h.
    expect(r.compliantHours).toBe(12);
    expect(r.compliance).toBe(1);
    const late = rpoCompliance(
      [t('2026-10-08T12:00')], // 36 h before the start
      t('2026-10-10T00:00'),
      t('2026-10-10T12:00'),
      T,
      t('2026-09-01T00:00'),
    );
    // Age at the start is 36 h (the limit); every instant after is over it.
    expect(late.compliantHours).toBe(0);
    expect(late.metNow).toBe(false);
    expect(late.compliance).toBe(0);
  });

  it('gives a new schedule one objective to make its first backup', () => {
    const created = t('2026-10-10T00:00');
    const none = rpoCompliance([], t('2026-10-01T00:00'), t('2026-10-11T00:00'), T, created);
    // Measured from creation: 24 h, all within 36 h.
    expect(none).toMatchObject({
      measuredHours: 24,
      compliance: 1,
      metNow: true,
      lastSuccessAt: null,
      ageHours: null,
    });
    const long = rpoCompliance([], t('2026-10-01T00:00'), t('2026-10-12T00:00'), T, created);
    // 48 h measured: 36 ok, 12 not.
    expect(long.compliantHours).toBe(36);
    expect(long.metNow).toBe(false);
  });

  it('ignores successes after the end and counts those before as the anchor only', () => {
    const r = rpoCompliance(
      [t('2026-10-01T00:00'), t('2026-10-20T00:00')],
      t('2026-10-10T00:00'),
      t('2026-10-11T00:00'),
      T,
      t('2026-09-01T00:00'),
    );
    expect(r.successes).toBe(0);
    expect(r.lastSuccessAt).toBe('2026-10-01T00:00:00.000Z');
    expect(r.compliance).toBe(0);
  });

  it('does not depend on the order of the successes', () => {
    const s = [t('2026-10-06T02:00'), t('2026-10-01T02:00'), t('2026-10-05T02:00')];
    const sorted = [...s].sort((a, b) => a.getTime() - b.getTime());
    const args = [t('2026-10-01T02:00'), t('2026-10-07T02:00'), T, t('2026-09-01T00:00')] as const;
    expect(rpoCompliance(s, ...args)).toEqual(rpoCompliance(sorted, ...args));
  });

  it('measures nothing for an empty window', () => {
    const r = rpoCompliance([], t('2026-10-10T00:00'), t('2026-10-10T00:00'), T, null);
    expect(r.compliance).toBeNull();
  });
});

describe('staleNamespaces', () => {
  const now = t('2026-10-17T12:00');
  it('lists the namespaces older than the limit or never backed up, the most neglected first', () => {
    const out = staleNamespaces(
      [
        { namespace: 'fresh', lastBackupAt: t('2026-10-17T00:00'), scheduled: true }, // 12 h
        { namespace: 'edge', lastBackupAt: t('2026-10-15T12:00'), scheduled: true }, // exactly 48 h: not stale
        { namespace: 'old', lastBackupAt: t('2026-10-10T12:00'), scheduled: false }, // 168 h
        { namespace: 'older', lastBackupAt: t('2026-09-17T12:00'), scheduled: false }, // 720 h
        { namespace: 'zzz-never', lastBackupAt: null, scheduled: false },
        { namespace: 'aaa-never', lastBackupAt: null, scheduled: true },
      ],
      48,
      now,
    );
    expect(out.map((r) => r.namespace)).toEqual(['aaa-never', 'zzz-never', 'older', 'old']);
    expect(out.find((r) => r.namespace === 'old')?.hoursSince).toBe(168);
    expect(out[0]).toMatchObject({ lastBackupAt: null, hoursSince: null, scheduled: true });
  });
  it('is empty when everything is covered', () => {
    expect(
      staleNamespaces([{ namespace: 'a', lastBackupAt: now, scheduled: true }], 1, now),
    ).toEqual([]);
  });
});
