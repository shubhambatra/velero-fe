import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactElement, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/client';
import { backupPhaseTotals } from '@/lib/fleet-charts';
import type { FleetCluster } from '@/lib/fleet';
import { healthCounts } from '@/lib/fleet-view';
import { percent, windowQuery, type CoverageReport, type SuccessRateReport } from '@/lib/reports';

const TICK = { fill: 'var(--muted-foreground)', fontSize: 11 };

const OUTCOME_COLOUR: Readonly<Record<string, string>> = {
  Completed: 'var(--status-ok)',
  PartiallyFailed: 'var(--status-warn)',
  Failed: 'var(--status-error)',
};

function ChartCard({
  title,
  empty,
  children,
}: {
  title: string;
  empty?: string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {empty === undefined ? (
          <div className="h-56 w-full">{children}</div>
        ) : (
          <p className="text-sm text-muted-foreground">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}

function Donut({
  label,
  data,
}: {
  label: string;
  data: { name: string; value: number; fill: string }[];
}): ReactElement {
  return (
    <div role="img" aria-label={label} className="h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%"></Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * The fleet overview's graphs (counterpart of the single-cluster Velero UI dashboard): backup
 * outcomes over the last week, backups by status, cluster health, and namespaces without a
 * recent backup. The first and last come from the reports API, so they respect the caller's access.
 */
export function FleetCharts({
  orgId,
  clusters,
}: {
  orgId: string;
  clusters: readonly FleetCluster[];
}): ReactElement {
  const success = useQuery({
    queryKey: ['org', orgId, 'fleet-chart', 'success'],
    queryFn: ({ signal }) =>
      api<SuccessRateReport>(`/orgs/${orgId}/reports/success-rate?${windowQuery(7)}&bucket=day`, {
        signal,
      }),
  });
  const coverage = useQuery({
    queryKey: ['org', orgId, 'fleet-chart', 'coverage'],
    queryFn: ({ signal }) =>
      api<CoverageReport>(`/orgs/${orgId}/reports/coverage?hours=48`, { signal }),
  });

  const phases = useMemo(
    () =>
      Object.entries(backupPhaseTotals(clusters)).map(([name, value]) => ({
        name,
        value,
        fill: OUTCOME_COLOUR[name] ?? 'var(--muted-foreground)',
      })),
    [clusters],
  );
  const health = useMemo(() => {
    const h = healthCounts(clusters);
    return [
      { name: 'Healthy', value: h.healthy, fill: 'var(--status-ok)' },
      { name: 'Warning', value: h.warning, fill: 'var(--status-warn)' },
      { name: 'Critical', value: h.critical, fill: 'var(--status-error)' },
      { name: 'Offline', value: h.offline, fill: 'var(--muted-foreground)' },
    ].filter((d) => d.value > 0);
  }, [clusters]);
  const unprotected = (coverage.data?.clusters ?? [])
    .map((c) => ({ name: c.clusterName, namespaces: c.total }))
    .filter((c) => c.namespaces > 0);

  const points = success.data?.all.points ?? [];
  return (
    <section aria-label="Charts" className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard
        title={`Backups per day, last 7 days (success rate ${percent(success.data?.all.totals.rate ?? null)})`}
        empty={
          success.isPending
            ? 'Loading…'
            : points.length === 0
              ? 'No finished backups in this period.'
              : undefined
        }
      >
        <div role="img" aria-label="Backups finished per day, by outcome" className="h-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points.map((p) => ({ ...p, label: p.start.slice(5, 10) }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={TICK} />
              <YAxis allowDecimals={false} tick={TICK} />
              <Tooltip />
              <Bar dataKey="completed" name="Completed" stackId="a" fill="var(--status-ok)" />
              <Bar
                dataKey="partiallyFailed"
                name="Partially failed"
                stackId="a"
                fill="var(--status-warn)"
              />
              <Bar dataKey="failed" name="Failed" stackId="a" fill="var(--status-error)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      <ChartCard
        title="Backups by status"
        empty={phases.length === 0 ? 'No backups reported yet.' : undefined}
      >
        <Donut label="Backups by status" data={phases} />
      </ChartCard>

      <ChartCard title="Cluster health">
        <Donut label="Clusters by health" data={health} />
      </ChartCard>

      <ChartCard
        title="Namespaces without a backup in 48 h"
        empty={
          coverage.isPending
            ? 'Loading…'
            : unprotected.length === 0
              ? 'Every namespace has a recent backup.'
              : undefined
        }
      >
        <div role="img" aria-label="Unprotected namespaces per cluster" className="h-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={unprotected} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" allowDecimals={false} tick={TICK} />
              <YAxis type="category" dataKey="name" width={90} tick={TICK} />
              <Tooltip />
              <Bar dataKey="namespaces" name="Namespaces" fill="var(--status-warn)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
    </section>
  );
}
