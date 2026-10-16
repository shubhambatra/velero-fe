import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { useRefreshInterval } from '@/lib/events';
import {
  duration,
  phaseTone,
  STATUS_TONE,
  timeAgo,
  type ClusterOverview,
  type Resource,
} from '@/lib/fleet';

function Facts({ rows }: { rows: [string, ReactElement | string | null][] }): ReactElement {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

function RecentTable({
  title,
  rows,
}: {
  title: string;
  rows: Resource[] | null;
}): ReactElement | null {
  if (rows === null) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">None reported yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Name</th>
                <th className="p-2">Phase</th>
                <th className="p-2">Started</th>
                <th className="p-2">Duration</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-t border-control">
                  <td className="p-2 font-mono">
                    {r.name}
                    {r.createdByVfm && (
                      <Badge className="ml-2" tone="neutral">
                        via VFM
                      </Badge>
                    )}
                  </td>
                  <td className="p-2">
                    <Badge tone={phaseTone(r.phase)}>{r.phase ?? 'Unknown'}</Badge>
                  </td>
                  <td className="p-2">
                    <Time value={r.startedAt} />
                  </td>
                  <td className="p-2">{duration(r.startedAt, r.completedAt) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One cluster's overview tab: health, versions, policy, storage locations and recent
 * activity. A section the caller may not read is simply not there.
 */
export function ClusterPage({
  orgId,
  clusterId,
}: {
  orgId: string;
  clusterId: string;
}): ReactElement {
  const client = useQueryClient();
  const interval = useRefreshInterval();
  const key = ['org', orgId, 'cluster', clusterId, 'overview'];

  const overview = useQuery({
    queryKey: key,
    refetchInterval: interval,
    queryFn: ({ signal }) =>
      api<ClusterOverview>(`/orgs/${orgId}/clusters/${clusterId}/overview`, { signal }),
  });

  const refresh = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/clusters/${clusterId}/refresh-status`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      // The agent answers a moment later; the live stream usually beats this.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await client.invalidateQueries({ queryKey: key });
    },
  });

  const data = overview.data;
  const cluster = data?.cluster;
  const policy = cluster?.agentPolicy ?? null;

  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="overview">
      <ErrorNote message={refresh.isError ? errorMessage(refresh.error) : undefined} />

      {cluster !== undefined && data !== undefined && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Health</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Facts
                  rows={[
                    [
                      'Status',
                      <Badge key="s" tone={STATUS_TONE[cluster.status]}>
                        {cluster.status.toLowerCase()}
                      </Badge>,
                    ],
                    [
                      'Last heard from',
                      cluster.lastSeenAt === null ? null : timeAgo(cluster.lastSeenAt),
                    ],
                    [
                      'Inventory synced',
                      data.inventory.syncedAt === null
                        ? 'not yet'
                        : timeAgo(data.inventory.syncedAt),
                    ],
                  ]}
                />
                {(cluster.status === 'CONNECTED' ||
                  cluster.status === 'DISCONNECTED' ||
                  cluster.status === 'ENROLLED') && (
                  <div>
                    <Button
                      disabled={refresh.isPending || cluster.status !== 'CONNECTED'}
                      title={
                        cluster.status === 'CONNECTED'
                          ? undefined
                          : 'The agent must be connected to refresh.'
                      }
                      onClick={() => {
                        refresh.mutate();
                      }}
                    >
                      Refresh Velero status
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Versions</CardTitle>
              </CardHeader>
              <CardContent>
                <Facts
                  rows={[
                    ['Kubernetes', cluster.k8sVersion],
                    ['Velero', cluster.veleroVersion],
                    [
                      'Agent',
                      cluster.agentVersion === null ? null : (
                        <span key="a">
                          {cluster.agentVersion}
                          {cluster.agentUpdateAvailable && (
                            <Badge tone="warn" className="ml-2">
                              update available
                            </Badge>
                          )}
                        </span>
                      ),
                    ],
                    ['Chart', cluster.chartVersion],
                    ['Image', cluster.imageTag],
                  ]}
                />
                {cluster.veleroPlugins !== null && cluster.veleroPlugins.length > 0 && (
                  <ul aria-label="Velero plugins" className="mt-3 text-xs text-muted-foreground">
                    {cluster.veleroPlugins.map((p) => (
                      <li key={`${p.name}/${p.kind}`}>
                        {p.name} <span className="opacity-70">({p.kind})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Agent policy</CardTitle>
              <CardDescription>
                Set by the owner of this cluster at install time. The control plane cannot change
                it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {policy === null ? (
                <p className="text-sm text-muted-foreground">
                  The agent has not reported a policy yet.
                </p>
              ) : (
                <Facts
                  rows={[
                    [
                      'Mode',
                      <Badge key="m" tone={policy.readOnly ? 'warn' : 'ok'}>
                        {policy.readOnly ? 'read-only' : 'read and write'}
                      </Badge>,
                    ],
                    ['Restores', policy.allowRestore ? 'allowed' : 'disabled'],
                    [
                      'Restores never touch',
                      policy.restoreDeniedNamespaces.length === 0
                        ? 'nothing is protected'
                        : policy.restoreDeniedNamespaces.join(', '),
                    ],
                    ['Storage location changes', policy.allowBslWrite ? 'allowed' : 'disabled'],
                    ['Live logs', policy.allowLogStreaming ? 'allowed' : 'disabled'],
                  ]}
                />
              )}
            </CardContent>
          </Card>

          {data.locations !== null && (
            <Card>
              <CardHeader>
                <CardTitle>Backup storage locations</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {data.locations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None reported yet.</p>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th className="p-2">Name</th>
                        <th className="p-2">Provider</th>
                        <th className="p-2">State</th>
                        <th className="p-2">Last validated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.locations.map((l) => (
                        <tr key={l.name} className="border-t border-control align-top">
                          <td className="p-2 font-mono">
                            {l.name}
                            {l.isDefault && (
                              <Badge className="ml-2" tone="neutral">
                                default
                              </Badge>
                            )}
                          </td>
                          <td className="p-2">{l.provider ?? '—'}</td>
                          <td className="p-2">
                            <Badge tone={phaseTone(l.phase)}>{l.phase ?? 'Unknown'}</Badge>
                            {l.message !== null && (
                              <p className="mt-1 text-xs text-muted-foreground">{l.message}</p>
                            )}
                          </td>
                          <td className="p-2">
                            <Time value={l.lastValidated} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          )}

          <RecentTable title="Recent backups" rows={data.recentBackups} />
          <RecentTable title="Recent restores" rows={data.recentRestores} />

          {data.inventory.syncedAt === null && (
            <Card>
              <CardHeader>
                <CardTitle>Waiting for the first inventory</CardTitle>
                <CardDescription>
                  Backups, restores and storage locations appear once the agent has sent its first
                  snapshot.
                  {cluster.status !== 'CONNECTED' && ' The agent is not connected yet.'}
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </>
      )}
    </ClusterShell>
  );
}
