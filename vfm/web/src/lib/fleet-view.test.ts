import { describe, expect, it } from 'vitest';

import type { FleetCluster } from './fleet';
import {
  byUrgency,
  clusterHealth,
  filterClusters,
  healthCounts,
  labelOptions,
  mergeRows,
  NO_FILTER,
} from './fleet-view';

const base: FleetCluster = {
  id: 'c',
  name: 'a',
  status: 'CONNECTED',
  k8sVersion: null,
  veleroVersion: null,
  veleroPlugins: null,
  agentVersion: null,
  chartVersion: null,
  imageTag: null,
  agentUpdateAvailable: false,
  agentPolicy: null,
  lastSeenAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  labels: {},
  backups: { total: 1, byPhase: {}, last: { name: 'b', phase: 'Completed', completedAt: null } },
  schedules: { total: 1, failing: 0 },
  storage: { total: 1, available: 1, unavailable: 0 },
  syncedAt: null,
};
const make = (o: Partial<FleetCluster>): FleetCluster => ({ ...base, ...o });

describe('clusterHealth', () => {
  it.each([
    [{}, 'healthy'],
    [{ status: 'DISCONNECTED' }, 'warning'],
    [{ status: 'PENDING' }, 'offline'],
    [{ status: 'DISABLED' }, 'offline'],
    [{ storage: { total: 2, available: 1, unavailable: 1 } }, 'critical'],
    [
      {
        backups: { total: 1, byPhase: {}, last: { name: 'b', phase: 'Failed', completedAt: null } },
      },
      'critical',
    ],
    [
      {
        backups: {
          total: 1,
          byPhase: {},
          last: { name: 'b', phase: 'PartiallyFailed', completedAt: null },
        },
      },
      'warning',
    ],
    [{ schedules: { total: 2, failing: 1 } }, 'warning'],
    // Not allowed to read backups, schedules or storage: judged by the link alone, never as a failure.
    [{ backups: null, schedules: null, storage: null }, 'healthy'],
  ] as const)('%j is %s', (over, want) => {
    expect(clusterHealth(make(over as Partial<FleetCluster>))).toBe(want);
  });

  it('counts and orders by urgency', () => {
    const list = [
      make({ id: '1', name: 'z-ok' }),
      make({ id: '2', name: 'a-bad', status: 'DISCONNECTED' }),
      make({ id: '3', name: 'm-crit', storage: { total: 1, available: 0, unavailable: 1 } }),
    ];
    expect(healthCounts(list)).toEqual({ healthy: 1, warning: 1, critical: 1, offline: 0 });
    expect([...list].sort(byUrgency).map((c) => c.name)).toEqual(['m-crit', 'a-bad', 'z-ok']);
  });
});

describe('filtering', () => {
  const list = [
    make({ id: '1', name: 'prod-eu', labels: { env: 'prod', region: 'eu' } }),
    make({ id: '2', name: 'prod-us', labels: { env: 'prod', region: 'us' } }),
    make({ id: '3', name: 'staging', status: 'DISCONNECTED', labels: { env: 'staging' } }),
    make({ id: '4', name: 'bare' }),
  ];
  it('offers each label once, sorted', () => {
    expect(labelOptions(list)).toEqual(['env=prod', 'env=staging', 'region=eu', 'region=us']);
  });
  it('narrows by text (name or label), status and label together', () => {
    const ids = (f: Partial<typeof NO_FILTER>) =>
      filterClusters(list, { ...NO_FILTER, ...f }).map((c) => c.id);
    expect(ids({})).toEqual(['1', '2', '3', '4']);
    expect(ids({ q: 'PROD' })).toEqual(['1', '2']);
    expect(ids({ q: 'region=eu' })).toEqual(['1']);
    expect(ids({ status: 'DISCONNECTED' })).toEqual(['3']);
    expect(ids({ label: 'env=prod', q: 'us' })).toEqual(['2']);
    expect(ids({ label: 'env=nope' })).toEqual([]);
  });
});

describe('mergeRows', () => {
  it('interleaves clusters newest first, undated last', () => {
    const rows = mergeRows(
      [
        {
          cluster: { id: 'a', name: 'A' },
          rows: [
            { n: 'a1', t: '2026-01-02T00:00:00Z' },
            { n: 'a2', t: null },
          ],
        },
        {
          cluster: { id: 'b', name: 'B' },
          rows: [
            { n: 'b1', t: '2026-01-03T00:00:00Z' },
            { n: 'b2', t: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
      (r) => r.t,
    );
    expect(rows.map((r) => r.row.n)).toEqual(['b1', 'a1', 'b2', 'a2']);
    expect(rows[0]).toMatchObject({ clusterId: 'b', clusterName: 'B' });
  });
});
