import type { ClusterRow, ClusterStatus, FleetCluster, Tone } from './fleet';

/** What the fleet views let a person narrow the clusters by. */
export interface ClusterFilter {
  /** Matches the cluster's name or any label (`key=value`), case-insensitively. */
  q: string;
  status: ClusterStatus | '';
  /** One `key=value` label, as offered by `labelOptions`. */
  label: string;
}

export const NO_FILTER: ClusterFilter = { q: '', status: '', label: '' };

const labelPairs = (cluster: Pick<ClusterRow, 'labels'>): string[] =>
  Object.entries(cluster.labels ?? {}).map(([k, v]) => `${k}=${v}`);

/** Every `key=value` label in the fleet, sorted, for the label filter. */
export function labelOptions(clusters: readonly Pick<ClusterRow, 'labels'>[]): string[] {
  return [...new Set(clusters.flatMap(labelPairs))].sort((a, b) => a.localeCompare(b));
}

export function filterClusters<T extends ClusterRow>(
  clusters: readonly T[],
  filter: ClusterFilter,
): T[] {
  const q = filter.q.trim().toLowerCase();
  return clusters.filter((c) => {
    if (filter.status !== '' && c.status !== filter.status) return false;
    if (filter.label !== '' && !labelPairs(c).includes(filter.label)) return false;
    if (q === '') return true;
    return (
      c.name.toLowerCase().includes(q) || labelPairs(c).some((p) => p.toLowerCase().includes(q))
    );
  });
}

export type Health = 'healthy' | 'warning' | 'critical' | 'offline';

export const HEALTH_TONE: Record<Health, Tone> = {
  healthy: 'ok',
  warning: 'warn',
  critical: 'error',
  offline: 'neutral',
};

/**
 * One word for how a cluster is doing, for the health map. Offline is what the agent's link says; critical
 * is a failing latest backup or unavailable storage; warning is an invalid schedule or a disconnected agent.
 * A cluster the caller may not read backups on is judged only by what they may see.
 */
export function clusterHealth(c: FleetCluster): Health {
  if (c.status === 'PENDING' || c.status === 'ENROLLED' || c.status === 'DISABLED')
    return 'offline';
  if (c.status === 'DISCONNECTED') return 'warning';
  if ((c.storage?.unavailable ?? 0) > 0) return 'critical';
  const phase = c.backups?.last?.phase ?? null;
  if (phase === 'Failed' || phase === 'FailedValidation') return 'critical';
  if ((c.schedules?.failing ?? 0) > 0 || phase === 'PartiallyFailed') return 'warning';
  return 'healthy';
}

export function healthCounts(clusters: readonly FleetCluster[]): Record<Health, number> {
  const counts: Record<Health, number> = { healthy: 0, warning: 0, critical: 0, offline: 0 };
  for (const c of clusters) counts[clusterHealth(c)] += 1;
  return counts;
}

/** The most urgent first: critical, warning, offline, healthy; then by name. */
const ORDER: Record<Health, number> = { critical: 0, warning: 1, offline: 2, healthy: 3 };
export const byUrgency = (a: FleetCluster, b: FleetCluster): number =>
  ORDER[clusterHealth(a)] - ORDER[clusterHealth(b)] || a.name.localeCompare(b.name);

/** A row of a per-cluster list tagged with the cluster it came from. */
export interface FleetRow<T> {
  clusterId: string;
  clusterName: string;
  row: T;
}

/** Newest first by `when(row)`; rows without a time go last. */
export function mergeRows<T>(
  parts: readonly { cluster: Pick<ClusterRow, 'id' | 'name'>; rows: readonly T[] }[],
  when: (row: T) => string | null,
): FleetRow<T>[] {
  const all = parts.flatMap((p) =>
    p.rows.map((row) => ({ clusterId: p.cluster.id, clusterName: p.cluster.name, row })),
  );
  const time = (r: FleetRow<T>): number => {
    const t = when(r.row);
    return t === null ? Number.NEGATIVE_INFINITY : Date.parse(t);
  };
  return all.sort((a, b) => time(b) - time(a) || a.clusterName.localeCompare(b.clusterName));
}

/** The fleet lists read one page from each cluster; beyond this many, the person narrows with a filter. */
export const MAX_FLEET_CLUSTERS = 25;
