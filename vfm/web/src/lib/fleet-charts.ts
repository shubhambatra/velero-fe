import type { FleetCluster } from './fleet';

/** Backups of every readable cluster, summed by phase. */
export function backupPhaseTotals(clusters: readonly FleetCluster[]): Record<string, number> {
  const sum: Record<string, number> = {};
  for (const c of clusters) {
    for (const [phase, n] of Object.entries(c.backups?.byPhase ?? {})) {
      const key = phase === '' ? 'Unknown' : phase;
      sum[key] = (sum[key] ?? 0) + n;
    }
  }
  return sum;
}
