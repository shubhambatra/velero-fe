/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies and fixtures are untyped JSON on purpose */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false };
const PROBLEM = 'application/problem+json';
const CLUSTERS = [
  { id: 'c1', name: 'prod-eu' },
  { id: 'c2', name: 'dev' },
];
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const point = (day: string, c: number, p: number, f: number) => ({
  start: `2026-10-${day}T00:00:00.000Z`,
  completed: c,
  partiallyFailed: p,
  failed: f,
  rate: c + p + f === 0 ? null : c / (c + p + f),
});
const SUCCESS = {
  from: '2026-10-10T00:00:00.000Z',
  to: '2026-10-12T00:00:00.000Z',
  bucket: 'day',
  clusters: [
    {
      clusterId: 'c1',
      clusterName: 'prod-eu',
      points: [point('10', 3, 1, 0), point('11', 1, 0, 1)],
      totals: { completed: 4, partiallyFailed: 1, failed: 1, rate: 4 / 6 },
    },
    {
      clusterId: 'c2',
      clusterName: 'dev',
      points: [point('10', 2, 0, 0), point('11', 0, 0, 0)],
      totals: { completed: 2, partiallyFailed: 0, failed: 0, rate: 1 },
    },
  ],
  all: {
    points: [point('10', 5, 1, 0), point('11', 1, 0, 1)],
    totals: { completed: 6, partiallyFailed: 1, failed: 1, rate: 0.75 },
  },
  incomplete: false,
};
const COVERAGE = {
  hours: 48,
  generatedAt: new Date().toISOString(),
  clusters: [
    {
      clusterId: 'c1',
      clusterName: 'prod-eu',
      total: 5,
      namespaces: [
        { namespace: 'scratch', lastBackupAt: null, hoursSince: null, scheduled: false },
        { namespace: 'billing', lastBackupAt: hoursAgo(100), hoursSince: 100, scheduled: true },
      ],
    },
    { clusterId: 'c2', clusterName: 'dev', total: 3, namespaces: [] },
    { clusterId: 'c3', clusterName: 'empty', total: 0, namespaces: [] },
  ],
  incomplete: false,
};
const rpoRow = (over: Record<string, unknown>) => ({
  clusterId: 'c1',
  clusterName: 'prod-eu',
  schedule: 'nightly',
  cron: '0 2 * * *',
  targetHours: 36,
  compliance: 0.9,
  measuredHours: 720,
  compliantHours: 648,
  longestGapHours: 72,
  successes: 28,
  lastSuccessAt: hoursAgo(10),
  ageHours: 10,
  metNow: true,
  ...over,
});
const RPO = {
  from: '2026-09-17T00:00:00.000Z',
  to: '2026-10-17T00:00:00.000Z',
  schedules: [
    rpoRow({
      schedule: 'worst',
      compliance: 0.5833,
      metNow: false,
      lastSuccessAt: null,
      ageHours: null,
    }),
    rpoRow({ schedule: 'good', compliance: 1, longestGapHours: 24 }),
  ],
  incomplete: false,
};

function server(
  init: {
    success?: any;
    coverage?: any;
    rpo?: any;
    onReport?: (path: string) => Response | undefined;
  } = {},
) {
  const reports: string[] = [];
  stubFetch((url) => {
    const u = new URL(url, 'http://x');
    const path = u.pathname.replace('/api/v1', '') + u.search;
    if (path === '/auth/me') return jsonResponse({ user: USER });
    if (path === '/me/orgs')
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'OWNER', active: true }],
      });
    if (path === '/orgs/o1/clusters') return jsonResponse({ clusters: CLUSTERS });
    if (path.startsWith('/orgs/o1/reports/')) {
      reports.push(path);
      const custom = init.onReport?.(path);
      if (custom !== undefined) return custom;
      if (path.includes('/success-rate')) return jsonResponse(init.success ?? SUCCESS);
      if (path.includes('/coverage')) return jsonResponse(init.coverage ?? COVERAGE);
      if (path.includes('/rpo')) return jsonResponse(init.rpo ?? RPO);
    }
    return jsonResponse({});
  });
  return reports;
}

const open = async (tab?: string) => {
  const user = userEvent.setup();
  renderApp({ path: '/reports' });
  await screen.findByRole('heading', { name: 'Reports' });
  if (tab !== undefined) await user.click(screen.getByRole('button', { name: tab }));
  return user;
};
const last = (reports: string[], part: string) =>
  [...reports].reverse().find((p) => p.includes(part));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reports: navigation', () => {
  it('has a Reports link for a member, and opens on the success rate', async () => {
    server();
    renderApp({ path: '/reports' });
    expect(await screen.findByRole('link', { name: 'Reports' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Success rate' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('reports: success rate', () => {
  it('shows the headline rate with its counts and a row per cluster', async () => {
    server();
    await open();
    expect(await screen.findByText('75 %')).toBeVisible();
    expect(
      screen.getByText(
        /of 8 finished backups succeeded \(6 completed, 1 partially failed, 1 failed\)/,
      ),
    ).toBeVisible();
    const table = screen.getByRole('table', { name: 'Success rate by cluster' });
    const eu = within(table).getByText('prod-eu').closest('tr') as HTMLElement;
    expect(within(eu).getByText('66.7 %')).toBeVisible();
    const dev = within(table).getByText('dev').closest('tr') as HTMLElement;
    expect(within(dev).getByText('100 %')).toBeVisible();
  });

  it('draws the chart as a labelled picture of the table', async () => {
    server();
    await open();
    expect(
      await screen.findByRole('img', { name: 'Backups finished per period, by outcome' }),
    ).toBeInTheDocument();
  });

  it('says so when no cluster has anything', async () => {
    server({
      success: {
        ...SUCCESS,
        clusters: [],
        all: { points: [], totals: { completed: 0, partiallyFailed: 0, failed: 0, rate: null } },
      },
    });
    await open();
    expect(
      await screen.findByText(/No cluster you may read backups on has reported any yet/),
    ).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('—')).toBeVisible();
  });

  it('says when the numbers cover only the newest backups', async () => {
    server({ success: { ...SUCCESS, incomplete: true } });
    await open();
    expect(await screen.findByText(/more backups than could be read/)).toBeVisible();
  });

  it('shows the control plane’s reason when the report is refused', async () => {
    server({
      onReport: () =>
        jsonResponse(
          {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'a report covers at most 366 days',
          },
          { status: 400, contentType: PROBLEM },
        ),
    });
    await open();
    expect(await screen.findByRole('alert')).toHaveTextContent('a report covers at most 366 days');
  });

  it('asks for the last 30 days by day at first, and again when the period or grouping changes', async () => {
    const reports = server();
    const user = await open();
    await screen.findByText('75 %');
    const first = new URL(`http://x${reports[0] as string}`);
    expect(first.searchParams.get('bucket')).toBe('day');
    const from = new Date(first.searchParams.get('from') as string).getTime();
    const to = new Date(first.searchParams.get('to') as string).getTime();
    expect(Math.round((to - from) / 86_400_000)).toBe(30);

    await user.selectOptions(screen.getByLabelText('Group by'), 'week');
    await waitFor(() => {
      expect(last(reports, 'success-rate')).toContain('bucket=week');
    });
    await user.selectOptions(screen.getByLabelText('Period'), '7');
    await waitFor(() => {
      const q = new URL(`http://x${last(reports, 'success-rate') as string}`);
      expect(
        Math.round(
          (new Date(q.searchParams.get('to') as string).getTime() -
            new Date(q.searchParams.get('from') as string).getTime()) /
            86_400_000,
        ),
      ).toBe(7);
    });
  });

  it('narrows to one cluster from the cluster choice', async () => {
    const reports = server();
    const user = await open();
    await screen.findByText('75 %');
    expect(reports[0]).not.toContain('clusterId');
    await user.selectOptions(
      await screen
        .findByRole('option', { name: 'dev' })
        .then(() => screen.getByLabelText('Cluster')),
      'c2',
    );
    await waitFor(() => {
      expect(last(reports, 'success-rate')).toContain('&clusterId=c2');
    });
  });

  it('links to the same report as CSV', async () => {
    server();
    await open();
    const link = await screen.findByRole('link', { name: 'Download CSV' });
    expect(link.getAttribute('href')).toMatch(
      /\/orgs\/o1\/reports\/success-rate\?.*bucket=day.*&format=csv$/,
    );
    expect(link).toHaveAttribute('download');
  });
});

describe('reports: namespace coverage', () => {
  it('counts the namespaces without a recent backup and lists them per cluster', async () => {
    server();
    await open('Namespace coverage');
    expect(await screen.findByText('2')).toBeVisible();
    expect(screen.getByText('of 8 namespaces have no successful backup in 48 hours')).toBeVisible();
    const table = screen.getByRole('table', {
      name: 'Namespaces of prod-eu without a recent backup',
    });
    const scratch = within(table).getByText('scratch').closest('tr') as HTMLElement;
    expect(within(scratch).getByText('Never')).toBeVisible();
    expect(within(scratch).getByText('No schedule')).toBeVisible();
    const billing = within(table).getByText('billing').closest('tr') as HTMLElement;
    expect(within(billing).getByText('4 d 4 h')).toBeVisible();
    expect(within(billing).getByText('Covered by a schedule')).toBeVisible();
  });

  it('says when a cluster is fully covered, and when it reported no namespaces', async () => {
    server();
    await open('Namespace coverage');
    expect(await screen.findByText('Every namespace has a recent backup.')).toBeVisible();
    expect(screen.getByText('No namespaces reported.')).toBeVisible();
  });

  it('asks again with the hours chosen, and offers the CSV', async () => {
    const reports = server();
    const user = await open('Namespace coverage');
    await screen.findByText('Every namespace has a recent backup.');
    expect(reports.at(-1)).toContain('coverage?hours=48');
    await user.selectOptions(screen.getByLabelText(/No successful backup in the last/), '168');
    await waitFor(() => {
      expect(last(reports, 'coverage')).toContain('hours=168');
    });
    expect(
      (await screen.findByRole('link', { name: 'Download CSV' })).getAttribute('href'),
    ).toMatch(/coverage\?hours=168&format=csv$/);
  });

  it('says when the backups read were only the newest', async () => {
    server({ coverage: { ...COVERAGE, incomplete: true } });
    await open('Namespace coverage');
    expect(await screen.findByText(/more backups than could be read/)).toBeVisible();
  });
});

describe('reports: RPO compliance', () => {
  it('lists each schedule in the order the server gave, with its compliance and standing', async () => {
    server();
    await open('RPO compliance');
    const table = await screen.findByRole('table', { name: 'RPO compliance per schedule' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'worstprod-eu',
      'goodprod-eu',
    ]);
    const worst = rows[0] as HTMLElement;
    expect(within(worst).getByText('58.3 %')).toBeVisible();
    expect(within(worst).getByText('Past objective')).toBeVisible();
    expect(within(worst).getByText('Never')).toBeVisible();
    expect(within(worst).getByText('36 h')).toBeVisible();
    expect(within(worst).getByText('3 d')).toBeVisible();
    const good = rows[1] as HTMLElement;
    expect(within(good).getByText('100 %')).toBeVisible();
    expect(within(good).getByText('Within objective')).toBeVisible();
  });

  it('says when there is no schedule to measure', async () => {
    server({ rpo: { ...RPO, schedules: [] } });
    await open('RPO compliance');
    expect(await screen.findByText('No schedule to measure.')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('asks again with the objective chosen, and offers the CSV', async () => {
    const reports = server();
    const user = await open('RPO compliance');
    await screen.findByRole('table', { name: 'RPO compliance per schedule' });
    expect(reports.at(-1)).toContain('factor=1.5');
    await user.selectOptions(screen.getByLabelText('Objective'), '3');
    await waitFor(() => {
      expect(last(reports, '/rpo')).toContain('factor=3');
    });
    expect(
      (await screen.findByRole('link', { name: 'Download CSV' })).getAttribute('href'),
    ).toMatch(/\/rpo\?.*factor=3.*&format=csv$/);
  });

  it('keeps the cluster choice when changing report', async () => {
    const reports = server();
    const user = await open();
    await screen.findByText('75 %');
    await screen.findByRole('option', { name: 'dev' });
    await user.selectOptions(screen.getByLabelText('Cluster'), 'c1');
    await user.click(screen.getByRole('button', { name: 'RPO compliance' }));
    await waitFor(() => {
      expect(last(reports, '/rpo')).toContain('&clusterId=c1');
    });
  });
});
