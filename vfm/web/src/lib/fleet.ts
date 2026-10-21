/** Shapes returned by `GET /orgs/{orgId}/fleet` and `.../clusters/{id}/overview`, and what the UI derives from them. */

export type ClusterStatus = 'PENDING' | 'ENROLLED' | 'CONNECTED' | 'DISCONNECTED' | 'DISABLED';

export interface ClusterRow {
  id: string;
  name: string;
  status: ClusterStatus;
  k8sVersion: string | null;
  veleroVersion: string | null;
  veleroPlugins: { name: string; kind: string }[] | null;
  agentVersion: string | null;
  chartVersion: string | null;
  imageTag: string | null;
  agentUpdateAvailable: boolean;
  agentPolicy: AgentPolicy | null;
  lastSeenAt: string | null;
  createdAt: string;
  /** Absent in older responses and fixtures. */
  labels?: Record<string, string>;
  grafanaUrlTemplate?: string | null;
  veleroCompatibility?: 'supported' | 'warn' | 'blocked' | 'unknown';
  environmentType?: string;
  apiEndpoint?: string | null;
  owner?: string | null;
}

export interface AgentPolicy {
  allowRestore: boolean;
  restoreDeniedNamespaces: string[];
  allowBslWrite: boolean;
  allowLogStreaming: boolean;
  logStreamDeniedNamespaces: string[];
  readOnly: boolean;
  /** G-4. Absent from older agents, which allow it. */
  denyClusterScopedRestore?: boolean;
}

export interface FleetCluster extends ClusterRow {
  /** `null` means the caller may not read backups here, which is not the same as none. */
  backups: {
    total: number;
    byPhase: Record<string, number>;
    last: { name: string; phase: string | null; completedAt: string | null } | null;
  } | null;
  schedules: { total: number; failing: number } | null;
  storage: { available: number; unavailable: number; total: number } | null;
  syncedAt: string | null;
}

export interface Resource {
  name: string;
  phase: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdByVfm: boolean;
}

export interface ClusterOverview {
  cluster: ClusterRow;
  inventory: {
    snapshotId: string | null;
    syncedAt: string | null;
    kinds: Record<string, { total: number; byPhase: Record<string, number> }>;
  };
  locations:
    | {
        name: string;
        provider: string | null;
        isDefault: boolean;
        phase: string | null;
        message: string | null;
        lastValidated: string | null;
        accessMode: string | null;
      }[]
    | null;
  recentBackups: Resource[] | null;
  recentRestores: Resource[] | null;
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'error';

/** The colour of a Velero phase. Always shown with the phase's own word, never alone. */
export function phaseTone(phase: string | null): Tone {
  switch (phase) {
    case 'Completed':
    case 'Available':
    case 'Enabled':
    case 'Ready':
    case 'Running':
    case 'Active':
    case 'Bound':
    case 'Succeeded':
      return 'ok';
    case 'Pending':
    case 'Warning':
    case 'Terminating':
      return 'warn';
    case 'PartiallyFailed':
    case 'Deleting':
    case 'WaitingForPluginOperationsPartiallyFailed':
    case 'FinalizingPartiallyFailed':
      return 'warn';
    case 'Failed':
    case 'FailedValidation':
    case 'Unavailable':
    case 'NotReady':
    case 'Lost':
      return 'error';
    default:
      return 'neutral';
  }
}

export const STATUS_TONE: Record<ClusterStatus, Tone> = {
  PENDING: 'warn',
  ENROLLED: 'neutral',
  CONNECTED: 'ok',
  DISCONNECTED: 'error',
  DISABLED: 'neutral',
};

export interface Attention {
  clusterId: string;
  clusterName: string;
  severity: 'error' | 'warn' | 'info';
  /** Stable across renders, so a list can key on it. */
  key: string;
  message: string;
}

/** How stale an inventory may get before a connected cluster is flagged. */
export const STALE_INVENTORY_MS = 30 * 60 * 1000;

const BAD_BACKUP: Record<string, { severity: 'error' | 'warn'; word: string }> = {
  Failed: { severity: 'error', word: 'failed' },
  FailedValidation: { severity: 'error', word: 'failed validation' },
  PartiallyFailed: { severity: 'warn', word: 'partially failed' },
};

/**
 * The "needs attention" list (PLAN.md §11.1 page 2). Pure, so every rule is a table
 * row in a test.
 *
 * Only what the caller may know is reported: a section that arrived as `null` produces
 * nothing, so a restricted user is never shown a warning that would reveal data they
 * cannot read. A disabled cluster is intentional and never flagged.
 */
export function needsAttention(
  clusters: readonly FleetCluster[],
  now: Date = new Date(),
): Attention[] {
  const out: Attention[] = [];
  for (const c of clusters) {
    const add = (severity: Attention['severity'], key: string, message: string): void => {
      out.push({ clusterId: c.id, clusterName: c.name, severity, key: `${c.id}:${key}`, message });
    };
    if (c.status === 'DISABLED') {
      continue;
    }

    if (c.status === 'DISCONNECTED') {
      add('error', 'disconnected', 'The agent is disconnected.');
    } else if (c.status === 'ENROLLED') {
      add('warn', 'enrolled', 'The agent has enrolled but has not connected yet.');
    } else if (c.status === 'PENDING') {
      add('warn', 'pending', 'Waiting for the agent to be installed.');
    }

    if (c.storage !== null && c.storage.unavailable > 0) {
      add(
        'error',
        'storage',
        c.storage.unavailable === 1
          ? '1 backup storage location is unavailable.'
          : `${c.storage.unavailable.toString()} backup storage locations are unavailable.`,
      );
    }

    const last = c.backups?.last;
    const bad = last?.phase == null ? undefined : BAD_BACKUP[last.phase];
    if (last !== undefined && last !== null && bad !== undefined) {
      add(bad.severity, 'last-backup', `The most recent backup, ${last.name}, ${bad.word}.`);
    }

    if (c.schedules !== null && c.schedules.failing > 0) {
      add(
        'warn',
        'schedules',
        c.schedules.failing === 1
          ? '1 schedule has an invalid configuration.'
          : `${c.schedules.failing.toString()} schedules have an invalid configuration.`,
      );
    }

    if (
      c.status === 'CONNECTED' &&
      c.syncedAt !== null &&
      now.getTime() - new Date(c.syncedAt).getTime() > STALE_INVENTORY_MS
    ) {
      add('warn', 'stale', 'The inventory has not been refreshed for over 30 minutes.');
    }

    if (c.agentUpdateAvailable) {
      add('info', 'update', 'An agent update is available.');
    }
  }

  const rank = { error: 0, warn: 1, info: 2 } as const;
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.clusterName.localeCompare(b.clusterName) ||
      a.key.localeCompare(b.key),
  );
}

export interface Totals {
  clusters: number;
  connected: number;
  backups: number | null;
  failedBackups: number | null;
  unavailableStorage: number | null;
}

/**
 * Fleet-wide counts. A figure is `null` when it would have to include a cluster the
 * caller may not read it for: a partial sum presented as the total would mislead.
 */
export function totals(clusters: readonly FleetCluster[]): Totals {
  const all = <T>(pick: (c: FleetCluster) => T | null): T[] | null => {
    const values = clusters.map(pick);
    return values.some((v) => v === null) ? null : (values as T[]);
  };
  const sum = (values: number[] | null): number | null =>
    values === null ? null : values.reduce((a, b) => a + b, 0);

  return {
    clusters: clusters.length,
    connected: clusters.filter((c) => c.status === 'CONNECTED').length,
    backups: sum(all((c) => c.backups?.total ?? null)),
    failedBackups: sum(
      all((c) =>
        c.backups === null
          ? null
          : (c.backups.byPhase.Failed ?? 0) + (c.backups.byPhase.PartiallyFailed ?? 0),
      ),
    ),
    unavailableStorage: sum(all((c) => c.storage?.unavailable ?? null)),
  };
}

const UNITS: [number, string][] = [
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'min'],
  [1_000, 's'],
];

/** "5 min ago". Anything within a few seconds, or in the future by clock skew, is "just now". */
export function timeAgo(value: string | null, now: Date = new Date()): string {
  if (value === null) {
    return 'never';
  }
  const ms = now.getTime() - new Date(value).getTime();
  if (Number.isNaN(ms)) {
    return 'unknown';
  }
  if (ms < 5_000) {
    return 'just now';
  }
  for (const [size, unit] of UNITS) {
    if (ms >= size) {
      return `${Math.floor(ms / size).toString()} ${unit} ago`;
    }
  }
  return 'just now';
}

/** "3 min 5 s" between two instants, or null if either is missing or the order is wrong. */
export function duration(start: string | null, end: string | null): string | null {
  if (start === null || end === null) {
    return null;
  }
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s.toString()} s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m.toString()} min ${(s % 60).toString()} s`;
  }
  return `${Math.floor(m / 60).toString()} h ${(m % 60).toString()} min`;
}
