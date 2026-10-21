import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { FleetCluster } from '@/lib/fleet';
import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false };
const NOW = new Date().toISOString();
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

function cluster(over: Partial<FleetCluster>): FleetCluster {
  return {
    id: 'c1',
    name: 'prod-eu',
    status: 'CONNECTED',
    k8sVersion: null,
    veleroVersion: 'v1.18.4',
    veleroPlugins: null,
    agentVersion: '0.1.0',
    chartVersion: null,
    imageTag: null,
    agentUpdateAvailable: false,
    agentPolicy: null,
    lastSeenAt: NOW,
    createdAt: NOW,
    labels: {},
    backups: {
      total: 1,
      byPhase: { Completed: 1 },
      last: { name: 'b', phase: 'Completed', completedAt: NOW },
    },
    schedules: { total: 1, failing: 0 },
    storage: { total: 1, available: 1, unavailable: 0 },
    syncedAt: NOW,
    ...over,
  };
}

const FLEET = [
  cluster({ id: 'c1', name: 'prod-eu', labels: { env: 'prod' } }),
  cluster({ id: 'c2', name: 'prod-us', labels: { env: 'prod' } }),
  cluster({
    id: 'c3',
    name: 'staging',
    labels: { env: 'staging' },
    storage: { total: 1, available: 0, unavailable: 1 },
  }),
];

const backup = (name: string, startedAt: string, phase = 'Completed') => ({
  name,
  phase,
  startedAt,
  completedAt: startedAt,
  schedule: null,
  storageLocation: 'default',
});

function server(clusters: FleetCluster[] = FLEET) {
  const requested: string[] = [];
  stubFetch((url) => {
    if (url.endsWith('/auth/me')) return jsonResponse({ user: USER });
    if (url.endsWith('/me/orgs')) {
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'OWNER', active: true }],
      });
    }
    if (url.endsWith('/orgs/o1/fleet')) return jsonResponse({ clusters });
    const m = /\/orgs\/o1\/clusters\/(c\d)\/backups\?(.*)$/.exec(url);
    if (m) {
      requested.push(`${m[1] ?? ''}?${m[2] ?? ''}`);
      if (m[1] === 'c3') {
        return jsonResponse(
          { type: 'about:blank', title: 'Forbidden', status: 403 },
          { status: 403 },
        );
      }
      return jsonResponse({
        items:
          m[1] === 'c1'
            ? [backup('eu-old', ago(120)), backup('eu-new', ago(5), 'Failed')]
            : [backup('us-mid', ago(30))],
        nextCursor: null,
      });
    }
    const o = /\/orgs\/o1\/clusters\/(c\d)\/overview$/.exec(url);
    if (o) {
      const found = clusters.find((c) => c.id === o[1]) ?? clusters[0];
      return jsonResponse({
        cluster: found,
        inventory: { snapshotId: null, syncedAt: null, kinds: {} },
        locations: [],
        recentBackups: [],
        recentRestores: [],
      });
    }
    return jsonResponse({ status: 'ok' });
  });
  return requested;
}

describe('fleet-wide backups', () => {
  it('merges every cluster newest first, names the clusters, and says which one it could not read', async () => {
    server();
    renderApp({ path: '/fleet/backups' });

    await screen.findByRole('heading', { name: 'All backups' });
    const table = await screen.findByRole('table');
    await waitFor(() => {
      expect(within(table).getAllByRole('row').length).toBe(4); // header + 3 backups
    });
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('cell')[1]?.textContent);
    expect(names).toEqual(['eu-new', 'us-mid', 'eu-old']);
    expect(within(table).getAllByRole('link', { name: 'prod-eu' })).toHaveLength(2);
    expect(within(table).getByRole('link', { name: 'eu-new' })).toHaveAttribute(
      'href',
      '/clusters/c1/backups/eu-new',
    );
    // The cluster the user may not read is named, and none of its data is shown.
    expect(await screen.findByText(/Not shown .*: staging/)).toBeVisible();
  });

  it('narrows to a group by label and sends the phase filter to every cluster', async () => {
    const requested = server();
    const user = userEvent.setup();
    renderApp({ path: '/fleet/backups' });
    await screen.findByRole('table');

    await user.selectOptions(screen.getByLabelText('Group (label)'), 'env=prod');
    await user.selectOptions(screen.getByLabelText('Phase'), 'Failed');
    await waitFor(() => {
      expect(requested.some((r) => r.startsWith('c1?') && r.includes('phase=Failed'))).toBe(true);
    });
    expect(requested.filter((r) => r.startsWith('c3?') && r.includes('phase=Failed'))).toEqual([]);
  });

  it('does not ask a cluster that never enrolled', async () => {
    const requested = server([cluster({ id: 'c1', name: 'new', status: 'PENDING' })]);
    renderApp({ path: '/fleet/backups' });
    expect(await screen.findByText('No connected clusters match.')).toBeVisible();
    expect(requested).toEqual([]);
  });
});

describe('cluster switcher', () => {
  it('lists the clusters, goes to one, and returns to the whole fleet', async () => {
    server();
    const user = userEvent.setup();
    renderApp({ path: '/' });
    const select = await screen.findByLabelText('Cluster');
    expect(within(select).getByRole('option', { name: 'All clusters (3)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'prod-eu' })).toBeInTheDocument();

    await user.selectOptions(select, 'c2');
    await waitFor(() => {
      expect(screen.getByLabelText('Cluster')).toHaveValue('c2');
    });
    await user.selectOptions(screen.getByLabelText('Cluster'), '');
    expect(await screen.findByRole('heading', { name: 'Fleet overview' })).toBeVisible();
  });

  it('is not shown for a single cluster', async () => {
    server([cluster({ id: 'c1', name: 'only' })]);
    renderApp({ path: '/' });
    await screen.findByRole('heading', { name: 'Fleet overview' });
    await screen.findByRole('region', { name: 'Fleet totals' });
    expect(screen.queryByLabelText('Cluster')).toBeNull();
  });
});

describe('fleet overview health and filters', () => {
  it('shows a health map, most urgent first, with counts', async () => {
    server();
    renderApp({ path: '/' });
    const map = await screen.findByRole('region', { name: 'Cluster health' });
    expect(within(map).getByText('2 healthy')).toBeVisible();
    expect(within(map).getByText('1 critical')).toBeVisible();
    const tiles = within(map).getAllByRole('link');
    expect(tiles[0]).toHaveAccessibleName('staging: critical');
    expect(tiles[0]).toHaveAttribute('href', '/clusters/c3');
  });

  it('filters the cluster table by group but keeps the fleet totals', async () => {
    server();
    const user = userEvent.setup();
    renderApp({ path: '/' });
    await screen.findByRole('region', { name: 'Fleet totals' });
    await user.selectOptions(screen.getByLabelText('Group (label)'), 'env=staging');
    expect(await screen.findByText('Clusters (1 of 3)')).toBeVisible();
    const totals = screen.getByRole('region', { name: 'Fleet totals' });
    expect(within(totals).getByText('3 / 3')).toBeVisible();
  });
});
