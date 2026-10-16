import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { ApiProblem } from '@/lib/api';
import { api, errorMessage } from '@/lib/client';
import { useRefreshInterval } from '@/lib/events';
import { duration } from '@/lib/fleet';
import type { BackupRow, Detail, RestoreRow } from '@/lib/resources';
import { PhaseBadge, ScopeText } from './cluster-lists';

function Facts({ rows }: { rows: [string, ReactNode][] }): ReactElement {
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

function useDetail<T>(orgId: string, clusterId: string, path: string, name: string) {
  const interval = useRefreshInterval();
  return useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'detail', path, name],
    refetchInterval: interval,
    // A 404 is an answer (gone, or not yours), not a fault to keep retrying.
    retry: (count, error) => !(error instanceof ApiProblem && error.status === 404) && count < 2,
    queryFn: ({ signal }) =>
      api<Detail<T>>(`/orgs/${orgId}/clusters/${clusterId}/${path}/${encodeURIComponent(name)}`, {
        signal,
      }),
  });
}

function NotFound({ noun, back }: { noun: string; back: ReactNode }): ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{`This ${noun} was not found`}</CardTitle>
        <CardDescription>
          It may have been deleted, or it may not be one you have access to. {back}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function Common({ detail }: { detail: Detail<unknown> }): ReactElement {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">No times have been reported yet.</p>
          ) : (
            <ol aria-label="Timeline" className="flex flex-col gap-1 text-sm">
              {detail.timeline.map((t) => (
                <li key={`${t.event}-${t.at}`} className="flex gap-3">
                  <span className="w-48 shrink-0">
                    <Time value={t.at} />
                  </span>
                  <span>{t.event}</span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>YAML</CardTitle>
          <CardDescription>
            The object as the cluster reports it, without managed fields or the last-applied
            annotation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <details>
            <summary className="cursor-pointer text-sm underline">Show YAML</summary>
            <pre
              aria-label="YAML"
              className="mt-2 overflow-x-auto rounded-md border border-control p-3 text-xs"
            >
              {detail.yaml}
            </pre>
          </details>
        </CardContent>
      </Card>
    </>
  );
}

interface Props {
  orgId: string;
  clusterId: string;
  name: string;
}

export function BackupDetailPage({ orgId, clusterId, name }: Props): ReactElement {
  const detail = useDetail<BackupRow>(orgId, clusterId, 'backups', name);
  const b = detail.data?.summary;
  const missing = detail.error instanceof ApiProblem && detail.error.status === 404;
  const back = (
    <Link to="/clusters/$clusterId/backups" params={{ clusterId }} className="underline">
      Back to backups
    </Link>
  );

  return (
    <ClusterShell
      orgId={orgId}
      clusterId={clusterId}
      tab="backups"
      title={name}
      crumbs={
        <>
          {' / '}
          {back}
        </>
      }
    >
      {missing && <NotFound noun="backup" back={back} />}
      <ErrorNote message={detail.isError && !missing ? errorMessage(detail.error) : undefined} />

      {b !== undefined && detail.data !== undefined && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Facts
                rows={[
                  ['Phase', <PhaseBadge key="p" phase={b.phase} />],
                  [
                    'Created',
                    b.createdByVfm ? 'in VFM' : 'outside VFM (for example with the Velero CLI)',
                  ],
                  ['Schedule', b.schedule],
                  ['Storage location', b.storageLocation],
                  ['Keeps for', b.ttl],
                  ['Expires', <Time key="e" value={b.expiresAt} />],
                  ['Duration', duration(b.startedAt, b.completedAt)],
                  ['Namespaces', <ScopeText key="s" scope={b.scope} />],
                  [
                    'Cluster-scoped resources',
                    b.includesClusterResources ? 'included' : 'not requested',
                  ],
                  [
                    'Items',
                    b.itemsBackedUp === null
                      ? null
                      : `${b.itemsBackedUp.toString()} of ${b.totalItems?.toString() ?? '?'} backed up`,
                  ],
                  [
                    'Volume snapshots',
                    b.volumeSnapshots.attempted === null
                      ? null
                      : `${(b.volumeSnapshots.completed ?? 0).toString()} of ${b.volumeSnapshots.attempted.toString()} completed`,
                  ],
                  [
                    'Problems',
                    <span key="x" className="flex gap-1">
                      <Badge
                        tone={b.errors > 0 ? 'error' : 'neutral'}
                      >{`${b.errors.toString()} errors`}</Badge>
                      <Badge
                        tone={b.warnings > 0 ? 'warn' : 'neutral'}
                      >{`${b.warnings.toString()} warnings`}</Badge>
                    </span>,
                  ],
                  ['Failure reason', b.failureReason],
                ]}
              />
              <div>
                <Button
                  disabled
                  title="Restoring from the UI arrives with the write operations (M4)."
                >
                  Restore from this backup
                </Button>
              </div>
            </CardContent>
          </Card>

          <Common detail={detail.data} />

          <Card>
            <CardHeader>
              <CardTitle>Volumes</CardTitle>
              <CardDescription>
                File-system and data-mover transfers recorded for this backup.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {detail.data.volumes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No volume transfers were recorded for this backup.
                </p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th className="p-2">Name</th>
                      <th className="p-2">Kind</th>
                      <th className="p-2">Phase</th>
                      <th className="p-2">Uploader</th>
                      <th className="p-2">Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.volumes.map((v) => (
                      <tr key={`${v.kind}-${v.name}`} className="border-t border-control">
                        <td className="p-2 font-mono">{v.name}</td>
                        <td className="p-2">
                          {v.kind === 'DATA_UPLOAD' ? 'Data upload' : 'Pod volume backup'}
                        </td>
                        <td className="p-2">
                          <PhaseBadge phase={v.phase} />
                        </td>
                        <td className="p-2">{v.uploader ?? '—'}</td>
                        <td className="p-2">
                          {v.bytesDone === null || v.totalBytes === null || v.totalBytes === 0
                            ? '—'
                            : `${Math.round((v.bytesDone / v.totalBytes) * 100).toString()}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </ClusterShell>
  );
}

export function RestoreDetailPage({ orgId, clusterId, name }: Props): ReactElement {
  const detail = useDetail<RestoreRow>(orgId, clusterId, 'restores', name);
  const r = detail.data?.summary;
  const missing = detail.error instanceof ApiProblem && detail.error.status === 404;
  const back = (
    <Link to="/clusters/$clusterId/restores" params={{ clusterId }} className="underline">
      Back to restores
    </Link>
  );

  return (
    <ClusterShell
      orgId={orgId}
      clusterId={clusterId}
      tab="restores"
      title={name}
      crumbs={
        <>
          {' / '}
          {back}
        </>
      }
    >
      {missing && <NotFound noun="restore" back={back} />}
      <ErrorNote message={detail.isError && !missing ? errorMessage(detail.error) : undefined} />

      {r !== undefined && detail.data !== undefined && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <Facts
                rows={[
                  ['Phase', <PhaseBadge key="p" phase={r.phase} />],
                  [
                    'Created',
                    r.createdByVfm ? 'in VFM' : 'outside VFM (for example with the Velero CLI)',
                  ],
                  [
                    'From backup',
                    r.backupName === null ? null : (
                      <Link
                        key="b"
                        to="/clusters/$clusterId/backups/$name"
                        params={{ clusterId, name: r.backupName }}
                        className="font-mono underline"
                      >
                        {r.backupName}
                      </Link>
                    ),
                  ],
                  ['From schedule', r.scheduleName],
                  ['Namespaces', <ScopeText key="s" scope={r.scope} />],
                  ['Existing resources', r.existingResourcePolicy ?? 'left as they are'],
                  ['Duration', duration(r.startedAt, r.completedAt)],
                  [
                    'Items',
                    r.itemsRestored === null
                      ? null
                      : `${r.itemsRestored.toString()} of ${r.totalItems?.toString() ?? '?'} restored`,
                  ],
                  [
                    'Problems',
                    <span key="x" className="flex gap-1">
                      <Badge
                        tone={r.errors > 0 ? 'error' : 'neutral'}
                      >{`${r.errors.toString()} errors`}</Badge>
                      <Badge
                        tone={r.warnings > 0 ? 'warn' : 'neutral'}
                      >{`${r.warnings.toString()} warnings`}</Badge>
                    </span>,
                  ],
                  ['Failure reason', r.failureReason],
                ]}
              />
            </CardContent>
          </Card>
          <Common detail={detail.data} />
        </>
      )}
    </ClusterShell>
  );
}
