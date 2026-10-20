import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';

import { ErrorNote } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { useRefreshInterval } from '@/lib/events';
import { grafanaUrl } from '@/lib/cluster-settings';
import type { ClusterOverview } from '@/lib/fleet';

export type ClusterTab =
  | 'overview'
  | 'backups'
  | 'restores'
  | 'schedules'
  | 'storage'
  | 'workloads'
  | 'events'
  | 'activity'
  | 'access'
  | 'settings';

const TABS: { id: ClusterTab; label: string; to: string }[] = [
  { id: 'overview', label: 'Overview', to: '/clusters/$clusterId' },
  { id: 'backups', label: 'Backups', to: '/clusters/$clusterId/backups' },
  { id: 'restores', label: 'Restores', to: '/clusters/$clusterId/restores' },
  { id: 'schedules', label: 'Schedules', to: '/clusters/$clusterId/schedules' },
  { id: 'storage', label: 'Storage', to: '/clusters/$clusterId/storage' },
  { id: 'workloads', label: 'Workloads', to: '/clusters/$clusterId/workloads' },
  { id: 'events', label: 'Events', to: '/clusters/$clusterId/events' },
  { id: 'activity', label: 'Activity', to: '/clusters/$clusterId/activity' },
  { id: 'access', label: 'Access', to: '/clusters/$clusterId/access' },
  { id: 'settings', label: 'Settings', to: '/clusters/$clusterId/settings' },
];

/** The header and tab strip every cluster page shares. */
export function ClusterShell({
  orgId,
  clusterId,
  tab,
  title,
  crumbs,
  children,
}: {
  orgId: string;
  clusterId: string;
  tab: ClusterTab;
  /** Replaces the cluster name as the page heading (a detail page's own name). */
  title?: string;
  crumbs?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const interval = useRefreshInterval();
  // The same query the overview page uses: one fetch serves both.
  const overview = useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'overview'],
    refetchInterval: interval,
    queryFn: ({ signal }) =>
      api<ClusterOverview>(`/orgs/${orgId}/clusters/${clusterId}/overview`, { signal }),
  });
  const name = overview.data?.cluster.name;
  const grafana =
    overview.data === undefined
      ? null
      : grafanaUrl(overview.data.cluster.grafanaUrlTemplate, overview.data.cluster);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm">
          <Link to="/" className="underline">
            Fleet overview
          </Link>
          {name !== undefined && (
            <>
              {' / '}
              <Link to="/clusters/$clusterId" params={{ clusterId }} className="underline">
                {name}
              </Link>
            </>
          )}
          {crumbs}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{title ?? name ?? 'Cluster'}</h1>
          {grafana !== null && (
            <a
              href={grafana}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
            >
              Metrics in Grafana<span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      </div>

      <nav
        aria-label="Cluster sections"
        className="flex flex-wrap gap-1 border-b border-border pb-2"
      >
        {TABS.map((t) =>
          t.id === tab ? (
            <span
              key={t.id}
              aria-current="page"
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground"
            >
              {t.label}
            </span>
          ) : (
            <Link
              key={t.id}
              to={t.to}
              params={{ clusterId }}
              className="rounded-md px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              {t.label}
            </Link>
          ),
        )}
      </nav>

      <ErrorNote message={overview.isError ? errorMessage(overview.error) : undefined} />
      {children}
    </div>
  );
}
