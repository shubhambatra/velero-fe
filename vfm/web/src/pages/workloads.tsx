import { useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { LiveLogsPanel, VeleroLogShortcuts } from '@/components/live-logs';
import { ResourceList, type Column, type Extra } from '@/components/resource-list';
import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/client';
import { cn } from '@/lib/cn';
import {
  type ContainerRow,
  type EventRow,
  type NamespaceRow,
  type NodeRow,
  type Page,
  type PodRow,
  type PvcRow,
} from '@/lib/resources';
import type { LogTarget } from '@/lib/log-session';
import { PhaseBadge } from '@/pages/cluster-lists';

interface Props {
  orgId: string;
  clusterId: string;
}

/** The namespaces to choose from in a filter: the ones the caller may see. */
function useNamespaceChoices(orgId: string, clusterId: string): Extra[] {
  const query = useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'namespace-choices'],
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      api<Page<NamespaceRow>>(
        `/orgs/${orgId}/clusters/${clusterId}/inventory/namespaces?limit=200`,
        {
          signal,
        },
      ),
  });
  const names = query.data?.items.map((n) => n.name) ?? [];
  return [
    { key: 'namespace', label: 'Namespace', options: names.map((n) => ({ label: n, value: n })) },
  ];
}

const VIEWS = [
  { id: 'namespaces', label: 'Namespaces' },
  { id: 'pods', label: 'Pods' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'pvcs', label: 'Volume claims' },
] as const;
type View = (typeof VIEWS)[number]['id'];

/**
 * What runs in a cluster (PLAN.md §7.1, §11.1): namespaces with the last successful
 * backup that covers each, pods with their containers, nodes and volume claims. Reading
 * a namespace's pods is also what asks a large cluster's agent to report them.
 */
export function WorkloadsPage({ orgId, clusterId }: Props): ReactElement {
  const [view, setView] = useState<View>('namespaces');
  // Following a namespace's "Pods" link filters the pods list to it.
  const [podNamespace, setPodNamespace] = useState('');
  // The container whose log is open, wherever it was chosen from.
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null);
  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="workloads">
      <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
        {VIEWS.map((v) => (
          <Button
            key={v.id}
            variant={view === v.id ? 'primary' : 'outline'}
            aria-pressed={view === v.id}
            onClick={() => {
              setView(v.id);
            }}
          >
            {v.label}
          </Button>
        ))}
      </div>
      {view === 'namespaces' && (
        <NamespacesTable
          orgId={orgId}
          clusterId={clusterId}
          onShowPods={(ns) => {
            setPodNamespace(ns);
            setView('pods');
          }}
        />
      )}
      {view === 'pods' && (
        <VeleroLogShortcuts orgId={orgId} clusterId={clusterId} onOpen={setLogTarget} />
      )}
      {logTarget !== null && (
        <LiveLogsPanel
          // A different container is a different session.
          key={`${logTarget.namespace}/${logTarget.pod}/${logTarget.container ?? ''}`}
          orgId={orgId}
          clusterId={clusterId}
          target={logTarget}
          onClose={() => {
            setLogTarget(null);
          }}
        />
      )}
      {view === 'pods' && (
        <PodsTable
          orgId={orgId}
          clusterId={clusterId}
          initialNamespace={podNamespace}
          onShowLogs={setLogTarget}
        />
      )}
      {view === 'nodes' && <NodesTable orgId={orgId} clusterId={clusterId} />}
      {view === 'pvcs' && <PvcsTable orgId={orgId} clusterId={clusterId} />}
    </ClusterShell>
  );
}

const age = (iso: string | null): string => {
  if (iso === null) return '';
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (Number.isNaN(hours) || hours < 0) return '';
  return hours < 1
    ? 'less than an hour ago'
    : hours < 48
      ? `${hours.toString()} h ago`
      : `${Math.floor(hours / 24).toString()} days ago`;
};

export function CoverageBadge({ row }: { row: NamespaceRow }): ReactElement {
  const c = row.coverage;
  if (c === undefined || c.state === 'none') {
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge tone="error">Never backed up</Badge>
        {c?.scheduled === true && <Badge tone="neutral">scheduled</Badge>}
      </span>
    );
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone={c.state === 'recent' ? 'ok' : 'warn'}>
          {c.state === 'recent' ? 'Backed up' : 'Stale'}
        </Badge>
        {c.scheduled && <Badge tone="neutral">scheduled</Badge>}
      </span>
      <span className="text-xs text-muted-foreground">
        <Time value={c.lastBackupAt} /> ({age(c.lastBackupAt)})
        {c.lastBackupName !== null && <> · {c.lastBackupName}</>}
      </span>
    </span>
  );
}

function NamespacesTable({
  orgId,
  clusterId,
  onShowPods,
}: Props & { onShowPods: (namespace: string) => void }): ReactElement {
  const columns: Column<NamespaceRow>[] = [
    { header: 'Name', cell: (n) => <span className="font-mono">{n.name}</span> },
    { header: 'Phase', cell: (n) => <PhaseBadge phase={n.phase} /> },
    {
      header: 'Last successful backup covering it',
      cell: (n) => <CoverageBadge row={n} />,
    },
    {
      header: 'Pods',
      cell: (n) => (
        <Button
          variant="outline"
          aria-label={`Show pods in ${n.name}`}
          onClick={() => {
            onShowPods(n.name);
          }}
        >
          Show pods
        </Button>
      ),
    },
  ];
  return (
    <ResourceList<NamespaceRow>
      orgId={orgId}
      clusterId={clusterId}
      path="inventory/namespaces"
      noun="namespaces"
      columns={columns}
      rowKey={(n) => n.name}
      sorts={[{ label: 'Name', value: 'name' }]}
      defaultSort="name"
      defaultOrder="asc"
      phases={[
        { label: 'Active', value: 'Active' },
        { label: 'Terminating', value: 'Terminating' },
      ]}
      emptyHint="No namespaces have been reported yet."
    />
  );
}

function Containers({
  containers,
  namespace,
  pod,
  onShowLogs,
}: {
  containers: ContainerRow[];
  namespace: string;
  pod: string;
  onShowLogs: (target: LogTarget) => void;
}): ReactElement {
  if (containers.length === 0) {
    return <p className="text-xs text-muted-foreground">No container status reported yet.</p>;
  }
  return (
    <table className="mt-2 w-full text-left text-xs">
      <thead>
        <tr>
          <th className="pr-3">Container</th>
          <th className="pr-3">Image</th>
          <th className="pr-3">State</th>
          <th className="pr-3">Ready</th>
          <th className="pr-3">Restarts</th>
          <th className="pr-3">Last ended because</th>
          <th>Log</th>
        </tr>
      </thead>
      <tbody>
        {containers.map((c) => {
          const name = c.name;
          return (
            <tr key={`${c.init ? 'init-' : ''}${c.name ?? ''}`}>
              <td className="pr-3 font-mono">
                {c.name}
                {c.init && <span className="text-muted-foreground"> (init)</span>}
              </td>
              <td className="pr-3 font-mono">{c.image}</td>
              <td className="pr-3">
                {c.state}
                {c.reason !== null && c.reason !== '' && <> · {c.reason}</>}
              </td>
              <td className="pr-3">{c.ready ? 'yes' : 'no'}</td>
              <td className="pr-3">{c.restarts}</td>
              <td className="pr-3">{c.lastTerminationReason ?? '—'}</td>
              <td>
                {name !== null && (
                  <Button
                    variant="outline"
                    aria-label={`Logs of ${name} in ${pod}`}
                    onClick={() => {
                      onShowLogs({ namespace, pod, container: name });
                    }}
                  >
                    Logs
                  </Button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PodsTable({
  orgId,
  clusterId,
  initialNamespace,
  onShowLogs,
}: Props & { initialNamespace: string; onShowLogs: (target: LogTarget) => void }): ReactElement {
  const extras = useNamespaceChoices(orgId, clusterId);
  const columns: Column<PodRow>[] = [
    { header: 'Namespace', cell: (p) => <span className="font-mono">{p.namespace}</span> },
    {
      header: 'Pod',
      cell: (p) => (
        <details>
          <summary className="cursor-pointer font-mono" aria-label={`Containers of ${p.name}`}>
            {p.name}
          </summary>
          <Containers
            containers={p.containers}
            namespace={p.namespace}
            pod={p.name}
            onShowLogs={onShowLogs}
          />
        </details>
      ),
    },
    {
      header: 'Phase',
      cell: (p) => (
        <span className="flex flex-col items-start gap-1">
          <PhaseBadge phase={p.phase} />
          {p.reason !== null && p.reason !== '' && (
            <span className="text-xs text-muted-foreground">{p.reason}</span>
          )}
        </span>
      ),
    },
    { header: 'Ready', cell: (p) => p.ready },
    {
      header: 'Restarts',
      cell: (p) => (
        <span className={cn(p.restarts > 5 && 'font-semibold text-destructive')}>{p.restarts}</span>
      ),
    },
    { header: 'Node', cell: (p) => p.node ?? '—' },
    {
      header: 'Owner',
      cell: (p) => (p.owner === null ? '—' : `${p.owner.kind ?? ''}/${p.owner.name ?? ''}`),
    },
    { header: 'Started', cell: (p) => <Time value={p.startedAt} /> },
  ];
  return (
    <ResourceList<PodRow>
      // A new namespace choice is a new list (and a new "someone is looking" signal).
      key={initialNamespace}
      orgId={orgId}
      clusterId={clusterId}
      path="inventory/pods"
      noun="pods"
      columns={columns}
      rowKey={(p) => `${p.namespace}/${p.name}`}
      sorts={[
        { label: 'Name', value: 'name' },
        { label: 'Phase', value: 'phase' },
        { label: 'Started', value: 'startedAt' },
      ]}
      defaultSort="name"
      defaultOrder="asc"
      phases={[
        { label: 'Running', value: 'Running' },
        { label: 'Pending', value: 'Pending' },
        { label: 'Failed', value: 'Failed' },
        { label: 'Succeeded', value: 'Succeeded' },
      ]}
      extras={extras}
      initialExtra={initialNamespace === '' ? undefined : { namespace: initialNamespace }}
      emptyHint="No pods have been reported. In a very large cluster, pods are reported for a namespace once you pick it."
    />
  );
}

function NodesTable({ orgId, clusterId }: Props): ReactElement {
  const columns: Column<NodeRow>[] = [
    { header: 'Name', cell: (n) => <span className="font-mono">{n.name}</span> },
    {
      header: 'State',
      cell: (n) => (
        <span className="flex flex-wrap items-center gap-1">
          <PhaseBadge phase={n.phase} />
          {!n.schedulable && <Badge tone="warn">cordoned</Badge>}
          {n.pressure.map((p) => (
            <Badge key={p} tone="error">
              {p}
            </Badge>
          ))}
        </span>
      ),
    },
    { header: 'Roles', cell: (n) => (n.roles.length === 0 ? 'worker' : n.roles.join(', ')) },
    { header: 'Kubelet', cell: (n) => n.kubeletVersion ?? '—' },
    { header: 'CPU', cell: (n) => n.allocatable.cpu ?? '—' },
    { header: 'Memory', cell: (n) => n.allocatable.memory ?? '—' },
    { header: 'Pods', cell: (n) => n.allocatable.pods ?? '—' },
    {
      header: 'Taints',
      cell: (n) =>
        n.taints.length === 0
          ? '—'
          : n.taints
              .map((t) => `${t.key ?? ''}${t.value ? `=${t.value}` : ''}:${t.effect ?? ''}`)
              .join(', '),
    },
  ];
  return (
    <ResourceList<NodeRow>
      orgId={orgId}
      clusterId={clusterId}
      path="inventory/nodes"
      noun="nodes"
      columns={columns}
      rowKey={(n) => n.name}
      sorts={[
        { label: 'Name', value: 'name' },
        { label: 'State', value: 'phase' },
      ]}
      defaultSort="name"
      defaultOrder="asc"
      phases={[
        { label: 'Ready', value: 'Ready' },
        { label: 'Not ready', value: 'NotReady' },
      ]}
      emptyHint="No nodes have been reported yet."
    />
  );
}

function PvcsTable({ orgId, clusterId }: Props): ReactElement {
  const extras = useNamespaceChoices(orgId, clusterId);
  const columns: Column<PvcRow>[] = [
    { header: 'Namespace', cell: (p) => <span className="font-mono">{p.namespace}</span> },
    { header: 'Claim', cell: (p) => <span className="font-mono">{p.name}</span> },
    { header: 'Status', cell: (p) => <PhaseBadge phase={p.phase} /> },
    { header: 'Capacity', cell: (p) => p.capacity ?? '—' },
    { header: 'Storage class', cell: (p) => p.storageClass ?? '—' },
    { header: 'Volume', cell: (p) => p.volume ?? '—' },
  ];
  return (
    <ResourceList<PvcRow>
      orgId={orgId}
      clusterId={clusterId}
      path="inventory/pvcs"
      noun="volume claims"
      columns={columns}
      rowKey={(p) => `${p.namespace}/${p.name}`}
      sorts={[
        { label: 'Name', value: 'name' },
        { label: 'Status', value: 'phase' },
      ]}
      defaultSort="name"
      defaultOrder="asc"
      phases={[
        { label: 'Bound', value: 'Bound' },
        { label: 'Pending', value: 'Pending' },
        { label: 'Lost', value: 'Lost' },
      ]}
      extras={extras}
      emptyHint="No volume claims have been reported yet."
    />
  );
}

/** Warnings, and anything about a Velero object, from the last hour (PLAN.md §7.1). */
export function EventsPage({ orgId, clusterId }: Props): ReactElement {
  const extras = useNamespaceChoices(orgId, clusterId);
  const columns: Column<EventRow>[] = [
    { header: 'Last seen', cell: (e) => <Time value={e.lastSeen} /> },
    { header: 'Type', cell: (e) => <PhaseBadge phase={e.type} /> },
    { header: 'Namespace', cell: (e) => <span className="font-mono">{e.namespace}</span> },
    {
      header: 'Object',
      cell: (e) => (
        <span className="font-mono">
          {e.object.kind}/{e.object.name}
        </span>
      ),
    },
    { header: 'Reason', cell: (e) => e.reason ?? '—' },
    { header: 'Message', cell: (e) => <span className="break-words">{e.message}</span> },
    { header: 'Count', cell: (e) => e.count },
  ];
  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="events">
      <p className="text-sm text-muted-foreground">
        Warnings, and anything about a Velero object, from the last hour.
      </p>
      <ResourceList<EventRow>
        orgId={orgId}
        clusterId={clusterId}
        path="inventory/events"
        noun="events"
        columns={columns}
        rowKey={(e) => `${e.namespace}/${e.name}`}
        sorts={[
          { label: 'Last seen', value: 'startedAt' },
          { label: 'Name', value: 'name' },
        ]}
        defaultSort="startedAt"
        defaultOrder="desc"
        phases={[
          { label: 'Warning', value: 'Warning' },
          { label: 'Normal', value: 'Normal' },
        ]}
        extras={extras}
        emptyHint="No warnings in the last hour."
      />
    </ClusterShell>
  );
}
