import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';

import { ClusterFilterBar } from '@/components/cluster-filter-bar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, inputClass } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { useRefreshInterval } from '@/lib/events';
import { phaseTone, timeAgo } from '@/lib/fleet';
import {
  filterClusters,
  MAX_FLEET_CLUSTERS,
  mergeRows,
  NO_FILTER,
  type ClusterFilter,
} from '@/lib/fleet-view';
import {
  PHASE_GROUPS,
  queryString,
  type BackupRow,
  type Page,
  type RestoreRow,
  type ScheduleRow,
} from '@/lib/resources';
import { useFleet } from '@/lib/use-fleet';

type Kind = 'backups' | 'restores' | 'schedules';

const TITLE: Record<Kind, string> = {
  backups: 'All backups',
  restores: 'All restores',
  schedules: 'All schedules',
};

/**
 * One list across the fleet (PLAN.md section 11.1: a fleet is the unit people operate). The control plane
 * authorizes each cluster on its own, so this reads each cluster's list as the signed-in person and merges
 * the answers: a cluster they may not read is named, not silently skipped, and shows nothing of its data.
 */
function FleetList<T extends { name: string; phase: string | null }>({
  orgId,
  kind,
  when,
  columns,
}: {
  orgId: string;
  kind: Kind;
  when: (row: T) => string | null;
  columns: { head: string; cell: (row: T, clusterId: string) => ReactElement | string }[];
}): ReactElement {
  const fleet = useFleet(orgId);
  const interval = useRefreshInterval();
  const [filter, setFilter] = useState<ClusterFilter>(NO_FILTER);
  const [phase, setPhase] = useState('');

  const all = fleet.data?.clusters ?? [];
  // Clusters that have never enrolled have nothing to list.
  const matching = filterClusters(all, filter).filter(
    (c) => c.status !== 'PENDING' && c.status !== 'ENROLLED',
  );
  const picked = matching.slice(0, MAX_FLEET_CLUSTERS);

  const results = useQueries({
    queries: picked.map((c) => ({
      queryKey: ['org', orgId, 'fleet-list', kind, c.id, phase],
      refetchInterval: interval,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<Page<T>>(
          `/orgs/${orgId}/clusters/${c.id}/${kind}?${queryString(
            kind === 'schedules' || phase === '' ? {} : { phase },
          )}`,
          { signal },
        ),
    })),
  });

  const parts = picked.map((cluster, i) => ({ cluster, rows: results[i]?.data?.items ?? [] }));
  const rows = mergeRows(parts, when);
  const unreadable = picked.filter((_, i) => results[i]?.isError === true);
  const loading = fleet.isPending || results.some((r) => r.isPending);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{TITLE[kind]}</h1>
        <p className="text-sm text-muted-foreground">
          Every cluster you can read, newest first. Open a row for its cluster page.
        </p>
      </div>

      <ErrorNote message={fleet.isError ? errorMessage(fleet.error) : undefined} />

      <div className="flex flex-wrap items-end gap-3">
        <ClusterFilterBar clusters={all} value={filter} onChange={setFilter} />
        {kind !== 'schedules' && (
          <div className="flex flex-col gap-1">
            <label htmlFor="fleet-phase" className="text-xs text-muted-foreground">
              Phase
            </label>
            <select
              id="fleet-phase"
              className={`${inputClass} w-auto`}
              value={phase}
              onChange={(e) => {
                setPhase(e.target.value);
              }}
            >
              <option value="">Any phase</option>
              {PHASE_GROUPS.map((g) => (
                <option key={g.label} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {matching.length > MAX_FLEET_CLUSTERS && (
        <p role="note" className="text-sm text-muted-foreground">
          {`Showing the first ${MAX_FLEET_CLUSTERS.toString()} of ${matching.length.toString()} clusters. Narrow the clusters above to see the rest.`}
        </p>
      )}
      {unreadable.length > 0 && (
        <p role="note" className="text-sm text-muted-foreground">
          {`Not shown (no access or not reachable): ${unreadable.map((c) => c.name).join(', ')}.`}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {`${rows.length.toString()} ${kind} on ${picked.length.toString()} ${picked.length === 1 ? 'cluster' : 'clusters'}`}
          </CardTitle>
          <CardDescription>The latest 50 from each cluster.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loading && rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {picked.length === 0
                ? 'No connected clusters match.'
                : `No ${kind} on the clusters shown.`}
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="p-2">Cluster</th>
                  <th className="p-2">Name</th>
                  {columns.map((c) => (
                    <th key={c.head} className="p-2">
                      {c.head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.clusterId}/${r.row.name}`} className="border-t border-control">
                    <td className="p-2">
                      <Link
                        to="/clusters/$clusterId"
                        params={{ clusterId: r.clusterId }}
                        className="underline"
                      >
                        {r.clusterName}
                      </Link>
                    </td>
                    <td className="p-2 font-medium">
                      {kind === 'schedules' ? (
                        <Link
                          to="/clusters/$clusterId/schedules"
                          params={{ clusterId: r.clusterId }}
                          className="underline"
                        >
                          {r.row.name}
                        </Link>
                      ) : (
                        <Link
                          to={
                            kind === 'backups'
                              ? '/clusters/$clusterId/backups/$name'
                              : '/clusters/$clusterId/restores/$name'
                          }
                          params={{ clusterId: r.clusterId, name: r.row.name }}
                          className="underline"
                        >
                          {r.row.name}
                        </Link>
                      )}
                    </td>
                    {columns.map((c) => (
                      <td key={c.head} className="p-2">
                        {c.cell(r.row, r.clusterId)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const phaseBadge = (phase: string | null): ReactElement => (
  <Badge tone={phaseTone(phase)}>{phase ?? 'Unknown'}</Badge>
);
const ago = (value: string | null): string => (value === null ? '—' : timeAgo(value));

export function FleetBackupsPage({ orgId }: { orgId: string }): ReactElement {
  return (
    <FleetList<BackupRow>
      orgId={orgId}
      kind="backups"
      when={(b) => b.startedAt}
      columns={[
        { head: 'Phase', cell: (b) => phaseBadge(b.phase) },
        { head: 'Started', cell: (b) => ago(b.startedAt) },
        { head: 'Schedule', cell: (b) => b.schedule ?? '—' },
        { head: 'Storage', cell: (b) => b.storageLocation ?? '—' },
      ]}
    />
  );
}

export function FleetRestoresPage({ orgId }: { orgId: string }): ReactElement {
  return (
    <FleetList<RestoreRow>
      orgId={orgId}
      kind="restores"
      when={(r) => r.startedAt}
      columns={[
        { head: 'Phase', cell: (r) => phaseBadge(r.phase) },
        { head: 'Started', cell: (r) => ago(r.startedAt) },
        { head: 'From backup', cell: (r) => r.backupName ?? '—' },
      ]}
    />
  );
}

export function FleetSchedulesPage({ orgId }: { orgId: string }): ReactElement {
  return (
    <FleetList<ScheduleRow>
      orgId={orgId}
      kind="schedules"
      when={(s) => s.lastBackup}
      columns={[
        { head: 'Phase', cell: (s) => phaseBadge(s.phase) },
        { head: 'Cron', cell: (s) => s.cron ?? '—' },
        { head: 'State', cell: (s) => (s.paused ? 'paused' : 'running') },
        { head: 'Last backup', cell: (s) => ago(s.lastBackup) },
      ]}
    />
  );
}
