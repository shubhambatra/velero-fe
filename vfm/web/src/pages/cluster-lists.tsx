import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { ResourceList, type Column } from '@/components/resource-list';
import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { duration, phaseTone } from '@/lib/fleet';
import {
  PHASE_GROUPS,
  useResourceList,
  type BackupRow,
  type LocationRow,
  type RepositoryRow,
  type RestoreRow,
  type ScheduleRow,
  type Scope,
} from '@/lib/resources';

export const PhaseBadge = ({ phase }: { phase: string | null }): ReactElement => (
  <Badge tone={phaseTone(phase)}>{phase ?? 'Unknown'}</Badge>
);

/** What an object covers: "all namespaces" or the names, with a count of the rest. */
export function ScopeText({ scope }: { scope: Scope }): ReactElement {
  if (scope.all) {
    return <span>all namespaces</span>;
  }
  return (
    <span>
      {scope.namespaces.join(', ')}
      {scope.more > 0 && (
        <span className="text-muted-foreground">{` +${scope.more.toString()} more`}</span>
      )}
    </span>
  );
}

const Problems = ({ warnings, errors }: { warnings: number; errors: number }): ReactElement =>
  warnings === 0 && errors === 0 ? (
    <span className="text-muted-foreground">none</span>
  ) : (
    <span className="flex gap-1">
      {errors > 0 && <Badge tone="error">{`${errors.toString()} errors`}</Badge>}
      {warnings > 0 && <Badge tone="warn">{`${warnings.toString()} warnings`}</Badge>}
    </span>
  );

interface Props {
  orgId: string;
  clusterId: string;
}

export function BackupsPage({ orgId, clusterId }: Props): ReactElement {
  const columns: Column<BackupRow>[] = [
    {
      header: 'Name',
      cell: (b) => (
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to="/clusters/$clusterId/backups/$name"
            params={{ clusterId, name: b.name }}
            className="font-mono underline"
          >
            {b.name}
          </Link>
          {b.createdByVfm && <Badge tone="neutral">via VFM</Badge>}
        </span>
      ),
    },
    { header: 'Phase', cell: (b) => <PhaseBadge phase={b.phase} /> },
    { header: 'Started', cell: (b) => <Time value={b.startedAt} /> },
    { header: 'Duration', cell: (b) => duration(b.startedAt, b.completedAt) ?? '—' },
    { header: 'Expires', cell: (b) => <Time value={b.expiresAt} /> },
    { header: 'Namespaces', cell: (b) => <ScopeText scope={b.scope} /> },
    {
      header: 'Items',
      cell: (b) =>
        b.itemsBackedUp === null
          ? '—'
          : `${b.itemsBackedUp.toString()} / ${b.totalItems?.toString() ?? '?'}`,
    },
    { header: 'Problems', cell: (b) => <Problems warnings={b.warnings} errors={b.errors} /> },
  ];
  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="backups">
      <ResourceList<BackupRow>
        orgId={orgId}
        clusterId={clusterId}
        path="backups"
        noun="backups"
        columns={columns}
        rowKey={(b) => b.name}
        sorts={[
          { label: 'Started', value: 'startedAt' },
          { label: 'Finished', value: 'completedAt' },
          { label: 'Expires', value: 'expiresAt' },
          { label: 'Name', value: 'name' },
          { label: 'Phase', value: 'phase' },
        ]}
        defaultSort="startedAt"
        phases={PHASE_GROUPS}
        extras={[
          {
            key: 'createdByVfm',
            label: 'Origin',
            options: [
              { label: 'Created in VFM', value: 'true' },
              { label: 'Created elsewhere', value: 'false' },
            ],
          },
        ]}
        emptyHint="No backups have been reported yet. They appear here once Velero creates one and the agent has synced."
      />
    </ClusterShell>
  );
}

export function RestoresPage({ orgId, clusterId }: Props): ReactElement {
  const columns: Column<RestoreRow>[] = [
    {
      header: 'Name',
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to="/clusters/$clusterId/restores/$name"
            params={{ clusterId, name: r.name }}
            className="font-mono underline"
          >
            {r.name}
          </Link>
          {r.createdByVfm && <Badge tone="neutral">via VFM</Badge>}
        </span>
      ),
    },
    { header: 'Phase', cell: (r) => <PhaseBadge phase={r.phase} /> },
    {
      header: 'From backup',
      cell: (r) =>
        r.backupName === null ? (
          '—'
        ) : (
          <Link
            to="/clusters/$clusterId/backups/$name"
            params={{ clusterId, name: r.backupName }}
            className="font-mono underline"
          >
            {r.backupName}
          </Link>
        ),
    },
    { header: 'Started', cell: (r) => <Time value={r.startedAt} /> },
    { header: 'Duration', cell: (r) => duration(r.startedAt, r.completedAt) ?? '—' },
    { header: 'Namespaces', cell: (r) => <ScopeText scope={r.scope} /> },
    { header: 'Problems', cell: (r) => <Problems warnings={r.warnings} errors={r.errors} /> },
  ];
  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="restores">
      <ResourceList<RestoreRow>
        orgId={orgId}
        clusterId={clusterId}
        path="restores"
        noun="restores"
        columns={columns}
        rowKey={(r) => r.name}
        sorts={[
          { label: 'Started', value: 'startedAt' },
          { label: 'Finished', value: 'completedAt' },
          { label: 'Name', value: 'name' },
          { label: 'Phase', value: 'phase' },
        ]}
        defaultSort="startedAt"
        phases={PHASE_GROUPS}
        emptyHint="No restores have been reported yet."
      />
    </ClusterShell>
  );
}

export function SchedulesPage({ orgId, clusterId }: Props): ReactElement {
  const columns: Column<ScheduleRow>[] = [
    { header: 'Name', cell: (s) => <span className="font-mono">{s.name}</span> },
    {
      header: 'State',
      cell: (s) => (
        <span className="flex flex-wrap items-center gap-2">
          <PhaseBadge phase={s.phase} />
          {s.paused && <Badge tone="warn">paused</Badge>}
          {s.validationErrors.length > 0 && (
            <span className="text-xs text-muted-foreground">{s.validationErrors.join('; ')}</span>
          )}
        </span>
      ),
    },
    { header: 'Cron', cell: (s) => <code>{s.cron ?? '—'}</code> },
    { header: 'Last backup', cell: (s) => <Time value={s.lastBackup} /> },
    { header: 'Namespaces', cell: (s) => <ScopeText scope={s.scope} /> },
    { header: 'Storage', cell: (s) => s.storageLocation ?? 'default' },
    { header: 'Keeps for', cell: (s) => s.ttl ?? '—' },
  ];
  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="schedules">
      <ResourceList<ScheduleRow>
        orgId={orgId}
        clusterId={clusterId}
        path="schedules"
        noun="schedules"
        columns={columns}
        rowKey={(s) => s.name}
        sorts={[
          { label: 'Name', value: 'name' },
          { label: 'Phase', value: 'phase' },
        ]}
        defaultSort="name"
        defaultOrder="asc"
        phases={[
          { label: 'Enabled', value: 'Enabled' },
          { label: 'Invalid', value: 'FailedValidation' },
        ]}
        extras={[
          {
            key: 'paused',
            label: 'Paused',
            options: [
              { label: 'Paused', value: 'true' },
              { label: 'Running', value: 'false' },
            ],
          },
        ]}
        emptyHint="No schedules have been reported yet."
      />
    </ClusterShell>
  );
}

function Section<T>({
  orgId,
  clusterId,
  path,
  title,
  empty,
  columns,
  rowKey,
}: Props & {
  path: string;
  title: string;
  empty: string;
  columns: Column<T>[];
  rowKey: (r: T) => string;
}): ReactElement {
  const list = useResourceList<T>(orgId, clusterId, path, { sort: 'name', order: 'asc' });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {list.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.header} className="p-2">
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={rowKey(r)} className="border-t border-control align-top">
                  {columns.map((c) => (
                    <td key={c.header} className="p-2">
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

export function StoragePage({ orgId, clusterId }: Props): ReactElement {
  const state = (phase: string | null, message: string | null): ReactElement => (
    <span>
      <PhaseBadge phase={phase} />
      {message !== null && (
        <span className="mt-1 block text-xs text-muted-foreground">{message}</span>
      )}
    </span>
  );
  const locationColumns: Column<LocationRow>[] = [
    {
      header: 'Name',
      cell: (l) => (
        <span className="font-mono">
          {l.name}
          {l.isDefault && (
            <Badge tone="neutral" className="ml-2">
              default
            </Badge>
          )}
        </span>
      ),
    },
    { header: 'Provider', cell: (l) => l.provider ?? '—' },
    { header: 'State', cell: (l) => state(l.phase, l.message) },
    {
      header: 'Bucket',
      cell: (l) =>
        l.bucket === null ? '—' : `${l.bucket}${l.prefix === null ? '' : `/${l.prefix}`}`,
    },
    { header: 'Access', cell: (l) => l.accessMode ?? '—' },
    { header: 'Last validated', cell: (l) => <Time value={l.lastValidated} /> },
    {
      header: 'Credential',
      cell: (l) =>
        l.credential === null ? (
          '—'
        ) : (
          <span title="Only the reference to the Secret is shown, never its contents">
            {l.credential.name ?? '?'} / {l.credential.key ?? '?'}
          </span>
        ),
    },
  ];
  const snapshotColumns: Column<LocationRow>[] = [
    { header: 'Name', cell: (l) => <span className="font-mono">{l.name}</span> },
    { header: 'Provider', cell: (l) => l.provider ?? '—' },
    { header: 'State', cell: (l) => state(l.phase, l.message) },
  ];
  const repoColumns: Column<RepositoryRow>[] = [
    { header: 'Name', cell: (r) => <span className="font-mono">{r.name}</span> },
    { header: 'State', cell: (r) => state(r.phase, r.message) },
    { header: 'Type', cell: (r) => r.repositoryType ?? '—' },
    { header: 'Volume namespace', cell: (r) => r.volumeNamespace ?? '—' },
    { header: 'Storage location', cell: (r) => r.storageLocation ?? '—' },
    { header: 'Last maintenance', cell: (r) => <Time value={r.lastMaintenance} /> },
  ];
  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="storage">
      <Section<LocationRow>
        orgId={orgId}
        clusterId={clusterId}
        path="backup-locations"
        title="Backup storage locations"
        empty="No backup storage locations have been reported yet."
        columns={locationColumns}
        rowKey={(l) => l.name}
      />
      <Section<LocationRow>
        orgId={orgId}
        clusterId={clusterId}
        path="snapshot-locations"
        title="Volume snapshot locations"
        empty="None. Volume snapshots use the cluster's snapshot class unless a location is configured."
        columns={snapshotColumns}
        rowKey={(l) => l.name}
      />
      <Section<RepositoryRow>
        orgId={orgId}
        clusterId={clusterId}
        path="repositories"
        title="Backup repositories"
        empty="None. Repositories appear when file-system backups are used."
        columns={repoColumns}
        rowKey={(r) => r.name}
      />
    </ClusterShell>
  );
}
