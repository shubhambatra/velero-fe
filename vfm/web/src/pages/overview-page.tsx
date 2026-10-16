import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { PRODUCT_NAME } from '@vfm/shared';

import { HealthIndicator } from '@/components/health-indicator';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { API_BASE_URL } from '@/lib/api';
import { api, errorMessage } from '@/lib/client';
import { useRefreshInterval } from '@/lib/events';
import {
  needsAttention,
  phaseTone,
  STATUS_TONE,
  timeAgo,
  totals,
  type Attention,
  type FleetCluster,
} from '@/lib/fleet';
import { useOrgs } from '@/lib/session';
import { canAdminister } from '@/lib/types';

const SEVERITY: Record<
  Attention['severity'],
  { label: string; tone: 'error' | 'warn' | 'neutral' }
> = {
  error: { label: 'Problem', tone: 'error' },
  warn: { label: 'Warning', tone: 'warn' },
  info: { label: 'Note', tone: 'neutral' },
};

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): ReactElement {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-4">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold">{value}</span>
        {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
      </CardContent>
    </Card>
  );
}

/** A figure that is `null` is one the caller may not see in full, so it is not a number. */
const figure = (value: number | null): string => (value === null ? '—' : value.toString());

/**
 * Fleet overview (PLAN.md §11.1 page 2): fleet-wide counts, a "needs attention" list
 * and every cluster the caller can see. Updated live; see `lib/events.ts`.
 */
export function OverviewPage(): ReactElement {
  const { active } = useOrgs(true);
  const orgId = active?.id;
  const interval = useRefreshInterval();

  const fleet = useQuery({
    queryKey: ['org', orgId, 'fleet'],
    enabled: orgId !== undefined,
    refetchInterval: interval,
    queryFn: ({ signal }) =>
      api<{ clusters: FleetCluster[] }>(`/orgs/${orgId ?? ''}/fleet`, { signal }),
  });

  const clusters = fleet.data?.clusters;
  const attention = clusters === undefined ? [] : needsAttention(clusters);
  const sums = clusters === undefined ? undefined : totals(clusters);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Fleet overview</h1>
        <p className="text-sm text-muted-foreground">
          {PRODUCT_NAME} manages Velero across your Kubernetes clusters.
        </p>
      </div>

      <ErrorNote message={fleet.isError ? errorMessage(fleet.error) : undefined} />

      {orgId === undefined && (
        <Card>
          <CardHeader>
            <CardTitle>No organization</CardTitle>
            <CardDescription>You do not belong to an organization yet.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {clusters !== undefined && sums !== undefined && clusters.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No clusters yet</CardTitle>
            <CardDescription>
              {canAdminister(active?.orgRole) ? (
                <>
                  Add a cluster to get its install command, then run it on the cluster.{' '}
                  <Link to="/clusters" className="underline">
                    Add a cluster
                  </Link>
                  .
                </>
              ) : (
                'No clusters are shared with you yet. Ask an administrator for access.'
              )}
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {clusters !== undefined && sums !== undefined && clusters.length > 0 && (
        <>
          <section aria-label="Fleet totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Figure
              label="Clusters"
              value={`${sums.connected.toString()} / ${sums.clusters.toString()}`}
              hint="connected"
            />
            <Figure label="Backups" value={figure(sums.backups)} />
            <Figure
              label="Failed backups"
              value={figure(sums.failedBackups)}
              hint="failed or partially failed"
            />
            <Figure
              label="Unavailable storage"
              value={figure(sums.unavailableStorage)}
              hint="backup locations"
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Needs attention</CardTitle>
            </CardHeader>
            <CardContent>
              {attention.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing needs attention.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {attention.map((a) => (
                    <li key={a.key} className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone={SEVERITY[a.severity].tone}>{SEVERITY[a.severity].label}</Badge>
                      <Link
                        to="/clusters/$clusterId"
                        params={{ clusterId: a.clusterId }}
                        className="font-medium underline"
                      >
                        {a.clusterName}
                      </Link>
                      <span>{a.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Clusters</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="p-2">Cluster</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Velero</th>
                    <th className="p-2">Last backup</th>
                    <th className="p-2">Schedules</th>
                    <th className="p-2">Storage</th>
                    <th className="p-2">Agent</th>
                  </tr>
                </thead>
                <tbody>
                  {clusters.map((c) => (
                    <tr key={c.id} className="border-t border-control">
                      <td className="p-2 font-medium">
                        <Link
                          to="/clusters/$clusterId"
                          params={{ clusterId: c.id }}
                          className="underline"
                        >
                          {c.name}
                        </Link>
                      </td>
                      <td className="p-2">
                        <Badge tone={STATUS_TONE[c.status]}>{c.status.toLowerCase()}</Badge>
                      </td>
                      <td className="p-2">{c.veleroVersion ?? '—'}</td>
                      <td className="p-2">
                        {c.backups === null ? (
                          <span title="You do not have access to backups on this cluster">—</span>
                        ) : c.backups.last === null ? (
                          'none yet'
                        ) : (
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge tone={phaseTone(c.backups.last.phase)}>
                              {c.backups.last.phase ?? 'Unknown'}
                            </Badge>
                            <span className="text-muted-foreground">
                              {timeAgo(c.backups.last.completedAt)}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        {c.schedules === null ? (
                          '—'
                        ) : c.schedules.failing > 0 ? (
                          <Badge tone="warn">{`${c.schedules.failing.toString()} invalid`}</Badge>
                        ) : (
                          `${c.schedules.total.toString()} ok`
                        )}
                      </td>
                      <td className="p-2">
                        {c.storage === null ? (
                          '—'
                        ) : c.storage.unavailable > 0 ? (
                          <Badge tone="error">{`${c.storage.unavailable.toString()} unavailable`}</Badge>
                        ) : (
                          `${c.storage.available.toString()} / ${c.storage.total.toString()} available`
                        )}
                      </td>
                      <td className="p-2">
                        {c.agentVersion ?? '—'}
                        {c.agentUpdateAvailable && (
                          <Badge tone="warn" className="ml-2">
                            update available
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Control plane</CardTitle>
          <CardDescription>
            Liveness and readiness are polled continuously, so a control plane that is down is
            visible here and in the header rather than surfacing as a failed action later.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <HealthIndicator />
          <span className="text-muted-foreground">
            API base <span className="font-mono">{API_BASE_URL}</span>
          </span>
        </CardContent>
      </Card>
    </div>
  );
}
