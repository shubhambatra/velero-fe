import { describe, expect, it } from 'vitest';

import {
  duration,
  needsAttention,
  phaseTone,
  STALE_INVENTORY_MS,
  timeAgo,
  totals,
  type FleetCluster,
} from './fleet';

const NOW = new Date('2026-10-16T12:00:00Z');

function cluster(overrides: Partial<FleetCluster> = {}): FleetCluster {
  return {
    id: 'c1',
    name: 'prod-eu',
    status: 'CONNECTED',
    k8sVersion: 'v1.31.0',
    veleroVersion: 'v1.18.4',
    veleroPlugins: [],
    agentVersion: '0.1.0',
    chartVersion: '0.1.0',
    imageTag: '0.1.0',
    agentUpdateAvailable: false,
    agentPolicy: null,
    lastSeenAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    backups: {
      total: 3,
      byPhase: { Completed: 3 },
      last: { name: 'b3', phase: 'Completed', completedAt: NOW.toISOString() },
    },
    schedules: { total: 1, failing: 0 },
    storage: { total: 1, available: 1, unavailable: 0 },
    syncedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('needsAttention', () => {
  it('says nothing about a healthy cluster', () => {
    expect(needsAttention([cluster()], NOW)).toEqual([]);
  });

  it.each([
    ['a disconnected agent', { status: 'DISCONNECTED' as const }, 'error', /disconnected/],
    [
      'an enrolled agent that never connected',
      { status: 'ENROLLED' as const },
      'warn',
      /not connected yet/,
    ],
    ['a cluster still waiting for its agent', { status: 'PENDING' as const }, 'warn', /installed/],
    [
      'an unavailable storage location',
      { storage: { total: 2, available: 1, unavailable: 1 } },
      'error',
      /1 backup storage location is unavailable/,
    ],
    [
      'several unavailable locations',
      { storage: { total: 3, available: 0, unavailable: 3 } },
      'error',
      /3 backup storage locations are unavailable/,
    ],
    [
      'a failed last backup',
      {
        backups: {
          total: 1,
          byPhase: {},
          last: { name: 'b9', phase: 'Failed', completedAt: null },
        },
      },
      'error',
      /b9, failed/,
    ],
    [
      'a partially failed last backup',
      {
        backups: {
          total: 1,
          byPhase: {},
          last: { name: 'b9', phase: 'PartiallyFailed', completedAt: null },
        },
      },
      'warn',
      /partially failed/,
    ],
    [
      'a backup that failed validation',
      {
        backups: {
          total: 1,
          byPhase: {},
          last: { name: 'b9', phase: 'FailedValidation', completedAt: null },
        },
      },
      'error',
      /failed validation/,
    ],
    [
      'one failing schedule',
      { schedules: { total: 2, failing: 1 } },
      'warn',
      /1 schedule has an invalid/,
    ],
    [
      'several failing schedules',
      { schedules: { total: 3, failing: 2 } },
      'warn',
      /2 schedules have an invalid/,
    ],
    ['an available agent update', { agentUpdateAvailable: true }, 'info', /update is available/],
    [
      'a stale inventory on a connected cluster',
      { syncedAt: new Date(NOW.getTime() - STALE_INVENTORY_MS - 1000).toISOString() },
      'warn',
      /30 minutes/,
    ],
  ])('flags %s', (_name, overrides, severity, message) => {
    const found = needsAttention([cluster(overrides)], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe(severity);
    expect(found[0]?.message).toMatch(message);
    expect(found[0]?.clusterName).toBe('prod-eu');
  });

  it('does not flag a fresh inventory or a successful last backup', () => {
    expect(
      needsAttention(
        [
          cluster({
            syncedAt: new Date(NOW.getTime() - STALE_INVENTORY_MS + 60_000).toISOString(),
          }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it('never flags a disabled cluster, whatever else is true of it', () => {
    expect(
      needsAttention(
        [
          cluster({
            status: 'DISABLED',
            storage: { total: 1, available: 0, unavailable: 1 },
            agentUpdateAvailable: true,
          }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it('reports nothing for what the caller may not read, rather than guessing', () => {
    expect(
      needsAttention([cluster({ backups: null, schedules: null, storage: null })], NOW),
    ).toEqual([]);
  });

  it('ignores staleness on a cluster that is not connected, where the disconnect says it already', () => {
    const stale = new Date(NOW.getTime() - 5 * STALE_INVENTORY_MS).toISOString();
    const found = needsAttention([cluster({ status: 'DISCONNECTED', syncedAt: stale })], NOW);
    expect(found.map((f) => f.key)).toEqual(['c1:disconnected']);
  });

  it('orders errors before warnings before notes, then by cluster name, and gives stable keys', () => {
    const found = needsAttention(
      [
        cluster({ id: 'b', name: 'zeta', agentUpdateAvailable: true }),
        cluster({ id: 'a', name: 'alpha', schedules: { total: 1, failing: 1 } }),
        cluster({ id: 'c', name: 'mid', status: 'DISCONNECTED' }),
        cluster({ id: 'd', name: 'beta', status: 'DISCONNECTED' }),
      ],
      NOW,
    );
    expect(found.map((f) => `${f.severity}:${f.clusterName}`)).toEqual([
      'error:beta',
      'error:mid',
      'warn:alpha',
      'info:zeta',
    ]);
    expect(new Set(found.map((f) => f.key)).size).toBe(found.length);
  });
});

describe('totals', () => {
  it('sums across clusters', () => {
    const t = totals([
      cluster({
        backups: { total: 3, byPhase: { Completed: 2, Failed: 1 }, last: null },
        storage: { total: 1, available: 0, unavailable: 1 },
      }),
      cluster({
        id: 'c2',
        name: 'b',
        status: 'DISCONNECTED',
        backups: { total: 2, byPhase: { PartiallyFailed: 2 }, last: null },
      }),
    ]);
    expect(t).toEqual({
      clusters: 2,
      connected: 1,
      backups: 5,
      failedBackups: 3,
      unavailableStorage: 1,
    });
  });

  it('refuses to present a partial sum as a total when a cluster is not fully readable', () => {
    const t = totals([cluster(), cluster({ id: 'c2', name: 'b', backups: null, storage: null })]);
    expect(t.backups).toBeNull();
    expect(t.failedBackups).toBeNull();
    expect(t.unavailableStorage).toBeNull();
    expect(t.clusters).toBe(2);
  });

  it('is zero for an empty fleet', () => {
    expect(totals([])).toEqual({
      clusters: 0,
      connected: 0,
      backups: 0,
      failedBackups: 0,
      unavailableStorage: 0,
    });
  });
});

describe('phaseTone', () => {
  it.each([
    ['Completed', 'ok'],
    ['Available', 'ok'],
    ['PartiallyFailed', 'warn'],
    ['Failed', 'error'],
    ['FailedValidation', 'error'],
    ['Unavailable', 'error'],
    ['InProgress', 'neutral'],
    [null, 'neutral'],
    ['SomethingNew', 'neutral'],
  ])('%s is %s', (phase, tone) => {
    expect(phaseTone(phase)).toBe(tone);
  });
});

describe('timeAgo', () => {
  it.each([
    [null, 'never'],
    ['2026-10-16T11:59:58Z', 'just now'],
    ['2026-10-16T12:00:30Z', 'just now'],
    ['2026-10-16T11:59:30Z', '30 s ago'],
    ['2026-10-16T11:55:00Z', '5 min ago'],
    ['2026-10-16T09:00:00Z', '3 h ago'],
    ['2026-10-14T12:00:00Z', '2 d ago'],
    ['garbage', 'unknown'],
  ])('%s -> %s', (value, text) => {
    expect(timeAgo(value, NOW)).toBe(text);
  });
});

describe('duration', () => {
  it.each([
    ['2026-10-16T01:00:00Z', '2026-10-16T01:00:42Z', '42 s'],
    ['2026-10-16T01:00:00Z', '2026-10-16T01:03:05Z', '3 min 5 s'],
    ['2026-10-16T01:00:00Z', '2026-10-16T03:20:00Z', '2 h 20 min'],
  ])('%s to %s is %s', (a, b, text) => {
    expect(duration(a, b)).toBe(text);
  });

  it('is null when it cannot be known', () => {
    expect(duration(null, '2026-10-16T01:00:00Z')).toBeNull();
    expect(duration('2026-10-16T02:00:00Z', '2026-10-16T01:00:00Z')).toBeNull();
    expect(duration('x', 'y')).toBeNull();
  });
});
