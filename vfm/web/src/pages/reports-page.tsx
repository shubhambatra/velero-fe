import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorNote, inputClass } from '@/components/ui/field';
import { API_BASE_URL } from '@/lib/api';
import { api, errorMessage } from '@/lib/client';
import {
  RANGES,
  duration,
  percent,
  windowQuery,
  type CoverageReport,
  type RpoReport,
  type SuccessRateReport,
} from '@/lib/reports';

const TABS = [
  { id: 'success', label: 'Success rate' },
  { id: 'coverage', label: 'Namespace coverage' },
  { id: 'rpo', label: 'RPO compliance' },
] as const;
type Tab = (typeof TABS)[number]['id'];

interface Named {
  id: string;
  name: string;
}

/**
 * Reports (PLAN.md §11.1 page 12): how often backups succeed, which namespaces have gone
 * unprotected, and whether each schedule meets its recovery-point objective. Each answer is
 * limited by the server to what the signed-in person may read, and every table can be
 * downloaded as CSV. The chart is a picture of the table beneath it, never the only copy.
 */
export function ReportsPage({ orgId }: { orgId: string }): ReactElement {
  const [tab, setTab] = useState<Tab>('success');
  const [clusterId, setClusterId] = useState('');
  const clusters = useQuery({
    queryKey: ['org', orgId, 'clusters'],
    queryFn: ({ signal }) => api<{ clusters: Named[] }>(`/orgs/${orgId}/clusters`, { signal }),
  });
  const cluster = clusterId === '' ? '' : `&clusterId=${clusterId}`;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Reports</h1>
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Report" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <Button
              key={t.id}
              variant={tab === t.id ? 'primary' : 'outline'}
              aria-pressed={tab === t.id}
              onClick={() => {
                setTab(t.id);
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Cluster</span>
          <select
            className={inputClass}
            value={clusterId}
            onChange={(e) => {
              setClusterId(e.target.value);
            }}
          >
            <option value="">All clusters</option>
            {clusters.data?.clusters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {tab === 'success' && <SuccessRate orgId={orgId} cluster={cluster} />}
      {tab === 'coverage' && <Coverage orgId={orgId} cluster={cluster} />}
      {tab === 'rpo' && <Rpo orgId={orgId} cluster={cluster} />}
    </div>
  );
}

/** A plain link to the same report as CSV; the session cookie authenticates it. */
function CsvLink({ path }: { path: string }): ReactElement {
  return (
    <a className="text-sm underline" href={`${API_BASE_URL}${path}`} download>
      Download CSV
    </a>
  );
}

function Incomplete({ shown }: { shown: boolean }): ReactElement | null {
  return shown ? (
    <p role="status" className="text-sm text-muted-foreground">
      There are more backups than could be read; the numbers cover the newest ones.
    </p>
  ) : null;
}

function RangePicker({
  days,
  onChange,
}: {
  days: number;
  onChange: (d: number) => void;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">Period</span>
      <select
        className={inputClass}
        value={days}
        onChange={(e) => {
          onChange(Number(e.target.value));
        }}
      >
        {RANGES.map((r) => (
          <option key={r.days} value={r.days}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SuccessRate({ orgId, cluster }: { orgId: string; cluster: string }): ReactElement {
  const [days, setDays] = useState(30);
  const [bucket, setBucket] = useState<'day' | 'week'>('day');
  const query = `${windowQuery(days)}&bucket=${bucket}${cluster}`;
  // The window is fixed when the choice is made, not re-read on every render.
  const path = useMemo(() => `/orgs/${orgId}/reports/success-rate?${query}`, [orgId, query]);
  const report = useQuery({
    queryKey: ['org', orgId, 'report', 'success', days, bucket, cluster],
    queryFn: ({ signal }) => api<SuccessRateReport>(path, { signal }),
  });
  const data = report.data;
  const total = data?.all.totals;

  return (
    <section className="flex flex-col gap-3" aria-label="Success rate">
      <div className="flex flex-wrap items-end gap-3">
        <RangePicker days={days} onChange={setDays} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Group by</span>
          <select
            className={inputClass}
            value={bucket}
            onChange={(e) => {
              setBucket(e.target.value as 'day' | 'week');
            }}
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </label>
        {data !== undefined && <CsvLink path={`${path}&format=csv`} />}
      </div>
      <ErrorNote message={report.isError ? errorMessage(report.error) : undefined} />
      {report.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data !== undefined && total !== undefined && (
        <>
          <p className="text-sm">
            <span className="text-2xl font-semibold">{percent(total.rate)}</span>{' '}
            <span className="text-muted-foreground">
              {`of ${(total.completed + total.partiallyFailed + total.failed).toString()} finished backups succeeded (${total.completed.toString()} completed, ${total.partiallyFailed.toString()} partially failed, ${total.failed.toString()} failed)`}
            </span>
          </p>
          <Incomplete shown={data.incomplete} />
          {data.clusters.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No cluster you may read backups on has reported any yet.
            </p>
          ) : (
            <>
              <div
                role="img"
                aria-label="Backups finished per period, by outcome"
                className="h-64 w-full"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.all.points.map((p) => ({ ...p, label: p.start.slice(0, 10) }))}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    />
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
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Success rate by cluster</caption>
                  <thead>
                    <tr className="border-b border-border">
                      <th className="p-2">Cluster</th>
                      <th className="p-2">Success rate</th>
                      <th className="p-2">Completed</th>
                      <th className="p-2">Partially failed</th>
                      <th className="p-2">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.clusters.map((c) => (
                      <tr key={c.clusterId} className="border-b border-border last:border-0">
                        <td className="p-2 font-medium">{c.clusterName}</td>
                        <td className="p-2">{percent(c.totals.rate)}</td>
                        <td className="p-2">{c.totals.completed}</td>
                        <td className="p-2">{c.totals.partiallyFailed}</td>
                        <td className="p-2">{c.totals.failed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Coverage({ orgId, cluster }: { orgId: string; cluster: string }): ReactElement {
  const [hours, setHours] = useState(48);
  const path = `/orgs/${orgId}/reports/coverage?hours=${hours.toString()}${cluster}`;
  const report = useQuery({
    queryKey: ['org', orgId, 'report', 'coverage', hours, cluster],
    queryFn: ({ signal }) => api<CoverageReport>(path, { signal }),
  });
  const data = report.data;
  const stale = data?.clusters.reduce((n, c) => n + c.namespaces.length, 0) ?? 0;
  const all = data?.clusters.reduce((n, c) => n + c.total, 0) ?? 0;

  return (
    <section className="flex flex-col gap-3" aria-label="Namespace coverage">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">No successful backup in the last (hours)</span>
          <select
            className={inputClass}
            value={hours}
            onChange={(e) => {
              setHours(Number(e.target.value));
            }}
          >
            {[24, 48, 72, 168, 720].map((h) => (
              <option key={h} value={h}>
                {h.toString()}
              </option>
            ))}
          </select>
        </label>
        {data !== undefined && <CsvLink path={`${path}&format=csv`} />}
      </div>
      <ErrorNote message={report.isError ? errorMessage(report.error) : undefined} />
      {report.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data !== undefined && (
        <>
          <p className="text-sm">
            <span className="text-2xl font-semibold">{stale.toString()}</span>{' '}
            <span className="text-muted-foreground">{`of ${all.toString()} namespaces have no successful backup in ${hours.toString()} hours`}</span>
          </p>
          <Incomplete shown={data.incomplete} />
          {data.clusters.map((c) => (
            <div key={c.clusterId} className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">{c.clusterName}</h2>
              {c.namespaces.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {c.total === 0
                    ? 'No namespaces reported.'
                    : 'Every namespace has a recent backup.'}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">{`Namespaces of ${c.clusterName} without a recent backup`}</caption>
                    <thead>
                      <tr className="border-b border-border">
                        <th className="p-2">Namespace</th>
                        <th className="p-2">Last successful backup</th>
                        <th className="p-2">Age</th>
                        <th className="p-2">Schedule</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.namespaces.map((n) => (
                        <tr key={n.namespace} className="border-b border-border last:border-0">
                          <td className="p-2 font-mono">{n.namespace}</td>
                          <td className="p-2">
                            {n.lastBackupAt === null ? (
                              <Badge tone="error">Never</Badge>
                            ) : (
                              <Time value={n.lastBackupAt} />
                            )}
                          </td>
                          <td className="p-2">{duration(n.hoursSince)}</td>
                          <td className="p-2">
                            {n.scheduled ? 'Covered by a schedule' : 'No schedule'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function Rpo({ orgId, cluster }: { orgId: string; cluster: string }): ReactElement {
  const [days, setDays] = useState(30);
  const [factor, setFactor] = useState(1.5);
  const query = `${windowQuery(days)}&factor=${factor.toString()}${cluster}`;
  const path = useMemo(() => `/orgs/${orgId}/reports/rpo?${query}`, [orgId, query]);
  const report = useQuery({
    queryKey: ['org', orgId, 'report', 'rpo', days, factor, cluster],
    queryFn: ({ signal }) => api<RpoReport>(path, { signal }),
  });
  const data = report.data;

  return (
    <section className="flex flex-col gap-3" aria-label="RPO compliance">
      <p className="text-sm text-muted-foreground">
        For each schedule, the share of the period during which its newest successful backup was no
        older than the objective: its longest interval times the factor. Paused schedules are left
        out.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <RangePicker days={days} onChange={setDays} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Objective</span>
          <select
            className={inputClass}
            value={factor}
            onChange={(e) => {
              setFactor(Number(e.target.value));
            }}
          >
            {[1, 1.5, 2, 3].map((f) => (
              <option key={f} value={f}>{`${f.toString()} × the interval`}</option>
            ))}
          </select>
        </label>
        {data !== undefined && <CsvLink path={`${path}&format=csv`} />}
      </div>
      <ErrorNote message={report.isError ? errorMessage(report.error) : undefined} />
      {report.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data !== undefined && (
        <>
          <Incomplete shown={data.incomplete} />
          {data.schedules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No schedule to measure.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">RPO compliance per schedule</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th className="p-2">Schedule</th>
                    <th className="p-2">Compliance</th>
                    <th className="p-2">Objective</th>
                    <th className="p-2">Longest gap</th>
                    <th className="p-2">Last success</th>
                    <th className="p-2">Now</th>
                  </tr>
                </thead>
                <tbody>
                  {data.schedules.map((s) => (
                    <tr
                      key={`${s.clusterId}/${s.schedule}`}
                      className="border-b border-border last:border-0"
                    >
                      <td className="p-2">
                        <div className="font-medium">{s.schedule}</div>
                        <div className="text-xs text-muted-foreground">{s.clusterName}</div>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <div aria-hidden className="h-2 w-24 overflow-hidden rounded bg-muted">
                            <div
                              className={`h-full ${(s.compliance ?? 0) >= 0.99 ? 'bg-[var(--status-ok)]' : (s.compliance ?? 0) >= 0.9 ? 'bg-[var(--status-warn)]' : 'bg-[var(--status-error)]'}`}
                              style={{
                                width: `${Math.round((s.compliance ?? 0) * 100).toString()}%`,
                              }}
                            />
                          </div>
                          <span>{percent(s.compliance)}</span>
                        </div>
                      </td>
                      <td className="p-2">{duration(s.targetHours)}</td>
                      <td className="p-2">{duration(s.longestGapHours)}</td>
                      <td className="p-2">
                        {s.lastSuccessAt === null ? (
                          <Badge tone="error">Never</Badge>
                        ) : (
                          <Time value={s.lastSuccessAt} />
                        )}
                      </td>
                      <td className="p-2">
                        <Badge tone={s.metNow ? 'ok' : 'error'}>
                          {s.metNow ? 'Within objective' : 'Past objective'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
