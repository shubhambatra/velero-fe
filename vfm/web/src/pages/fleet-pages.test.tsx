import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { ClusterOverview, FleetCluster } from '@/lib/fleet';
import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false };
const NOW = new Date().toISOString();

function cluster(overrides: Partial<FleetCluster> = {}): FleetCluster {
  return {
    id: 'c1',
    name: 'prod-eu',
    status: 'CONNECTED',
    k8sVersion: 'v1.31.0',
    veleroVersion: 'v1.18.4',
    veleroPlugins: [{ name: 'velero.io/aws', kind: 'ObjectStore' }],
    agentVersion: '0.1.0',
    chartVersion: '0.1.0',
    imageTag: '0.1.0',
    agentUpdateAvailable: false,
    agentPolicy: {
      allowRestore: true,
      restoreDeniedNamespaces: ['kube-system'],
      allowBslWrite: true,
      allowLogStreaming: true,
      logStreamDeniedNamespaces: [],
      readOnly: false,
    },
    lastSeenAt: NOW,
    createdAt: NOW,
    backups: {
      total: 4,
      byPhase: { Completed: 3, Failed: 1 },
      last: { name: 'nightly-4', phase: 'Failed', completedAt: NOW },
    },
    schedules: { total: 2, failing: 1 },
    storage: { total: 2, available: 1, unavailable: 1 },
    syncedAt: NOW,
    ...overrides,
  };
}

function server(role: 'OWNER' | 'MEMBER', clusters: FleetCluster[], overview?: ClusterOverview) {
  return stubFetch((url, init) => {
    if (url.endsWith('/auth/me')) {
      return jsonResponse({ user: USER });
    }
    if (url.endsWith('/me/orgs')) {
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: role, active: true }],
      });
    }
    if (url.endsWith('/orgs/o1/fleet')) {
      return jsonResponse({ clusters });
    }
    if (url.endsWith('/overview') && overview !== undefined) {
      return jsonResponse(overview);
    }
    if (url.endsWith('/refresh-status') && init?.method === 'POST') {
      return jsonResponse({ id: 'cmd1' }, { status: 202 });
    }
    return jsonResponse({ status: 'ok' });
  });
}

describe('fleet overview', () => {
  it('shows totals, what needs attention, and each cluster with a link to it', async () => {
    server('OWNER', [cluster(), cluster({ id: 'c2', name: 'staging', status: 'DISCONNECTED' })]);
    renderApp({ path: '/' });

    const totals = await screen.findByRole('region', { name: 'Fleet totals' });
    expect(within(totals).getByText('1 / 2')).toBeVisible();
    expect(within(totals).getByText('8')).toBeVisible(); // 4 backups on each cluster
    expect(within(totals).getAllByText('2').length).toBeGreaterThan(0);

    const attention = screen.getByRole('heading', { name: 'Needs attention' }).closest('div')
      ?.parentElement as HTMLElement;
    expect(
      within(attention).getAllByText(/The most recent backup, nightly-4, failed/),
    ).toHaveLength(2);
    expect(within(attention).getByText(/The agent is disconnected/)).toBeVisible();
    expect(within(attention).getAllByText(/1 backup storage location is unavailable/)).toHaveLength(
      2,
    );

    const link = screen.getAllByRole('link', { name: 'prod-eu' })[0];
    expect(link).toHaveAttribute('href', '/clusters/c1');
    expect(screen.getAllByText('1 unavailable')).toHaveLength(2);
    expect(screen.getAllByText('1 invalid')).toHaveLength(2);
  });

  it('says so when nothing needs attention', async () => {
    server('OWNER', [
      cluster({
        backups: {
          total: 1,
          byPhase: { Completed: 1 },
          last: { name: 'b', phase: 'Completed', completedAt: NOW },
        },
        schedules: { total: 1, failing: 0 },
        storage: { total: 1, available: 1, unavailable: 0 },
      }),
    ]);
    renderApp({ path: '/' });
    expect(await screen.findByText('Nothing needs attention.')).toBeVisible();
  });

  it('shows a dash, not a zero, where the caller may not read, and no partial totals', async () => {
    server('MEMBER', [cluster({ backups: null, schedules: null, storage: null })]);
    renderApp({ path: '/' });

    const totals = await screen.findByRole('region', { name: 'Fleet totals' });
    // Backups, failed backups and unavailable storage are all unknown to this user.
    expect(within(totals).getAllByText('—')).toHaveLength(3);
    expect(screen.queryByText(/storage location/)).toBeNull();
  });

  it('tells an admin how to add a cluster, and a member to ask for access', async () => {
    server('OWNER', []);
    const { unmount } = renderApp({ path: '/' });
    expect(await screen.findByRole('link', { name: 'Add a cluster' })).toHaveAttribute(
      'href',
      '/clusters',
    );
    unmount();

    server('MEMBER', []);
    renderApp({ path: '/' });
    expect(await screen.findByText(/No clusters are shared with you yet/)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add a cluster' })).toBeNull();
  });

  it('flags an agent that is behind', async () => {
    server('OWNER', [cluster({ agentUpdateAvailable: true })]);
    renderApp({ path: '/' });
    expect((await screen.findAllByText('update available')).length).toBeGreaterThan(0);
  });
});

function overviewFor(overrides: Partial<ClusterOverview> = {}): ClusterOverview {
  return {
    cluster: cluster(),
    inventory: { snapshotId: 's1', syncedAt: NOW, kinds: { BACKUP: { total: 4, byPhase: {} } } },
    locations: [
      {
        name: 'default',
        provider: 'aws',
        isDefault: true,
        phase: 'Available',
        message: null,
        lastValidated: NOW,
        accessMode: 'ReadWrite',
      },
      {
        name: 'offsite',
        provider: 'gcp',
        isDefault: false,
        phase: 'Unavailable',
        message: 'permission denied',
        lastValidated: null,
        accessMode: null,
      },
    ],
    recentBackups: [
      {
        name: 'nightly-4',
        phase: 'Failed',
        startedAt: '2026-10-16T01:00:00Z',
        completedAt: '2026-10-16T01:03:05Z',
        createdByVfm: false,
      },
      {
        name: 'manual-1',
        phase: 'Completed',
        startedAt: '2026-10-15T01:00:00Z',
        completedAt: '2026-10-15T01:00:42Z',
        createdByVfm: true,
      },
    ],
    recentRestores: [],
    ...overrides,
  };
}

describe('cluster overview', () => {
  it('shows health, versions with plugins, policy, storage and recent backups', async () => {
    server('OWNER', [cluster()], overviewFor());
    renderApp({ path: '/clusters/c1' });

    expect(await screen.findByRole('heading', { level: 1, name: 'prod-eu' })).toBeVisible();
    expect(screen.getByText('v1.18.4')).toBeVisible();
    expect(
      within(screen.getByRole('list', { name: 'Velero plugins' })).getByText('velero.io/aws'),
    ).toBeVisible();

    expect(screen.getByText('read and write')).toBeVisible();
    expect(screen.getByText('kube-system')).toBeVisible();

    expect(screen.getByText('permission denied')).toBeVisible();
    expect(screen.getAllByText('default').length).toBeGreaterThan(0);

    const recent = screen.getByRole('heading', { name: 'Recent backups' }).closest('div')
      ?.parentElement as HTMLElement;
    expect(within(recent).getByText('nightly-4')).toBeVisible();
    expect(within(recent).getByText('3 min 5 s')).toBeVisible();
    expect(within(recent).getByText('via VFM')).toBeVisible();
    expect(within(recent).getByText('Failed')).toBeVisible();
  });

  it('shows UTC on hover for every time', async () => {
    server('OWNER', [cluster()], overviewFor());
    renderApp({ path: '/clusters/c1' });
    await screen.findByText('nightly-4');
    const times = document.querySelectorAll('time');
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) {
      expect(t.getAttribute('title')).toMatch(/ UTC$/);
    }
  });

  it('leaves out sections the caller may not read instead of showing them empty', async () => {
    server(
      'MEMBER',
      [cluster()],
      overviewFor({ locations: null, recentBackups: null, recentRestores: null }),
    );
    renderApp({ path: '/clusters/c1' });

    await screen.findByRole('heading', { level: 1, name: 'prod-eu' });
    expect(screen.queryByText('Backup storage locations')).toBeNull();
    expect(screen.queryByText('Recent backups')).toBeNull();
    expect(screen.queryByText('Recent restores')).toBeNull();
  });

  it('shows every tab of the plan as a working link', async () => {
    server('OWNER', [cluster()], overviewFor());
    renderApp({ path: '/clusters/c1' });

    const tabs = await screen.findByRole('navigation', { name: 'Cluster sections' });
    for (const [label, href] of [
      ['Activity', '/clusters/c1/activity'],
      ['Access', '/clusters/c1/access'],
      ['Settings', '/clusters/c1/settings'],
    ] as const) {
      expect(within(tabs).getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
    // Nothing in the strip is a dead button.
    expect(within(tabs).queryAllByRole('button')).toEqual([]);
    // The tabs that exist are real links, the live view's among them.
    expect(within(tabs).getByRole('link', { name: 'Workloads' })).toHaveAttribute(
      'href',
      '/clusters/c1/workloads',
    );
    expect(within(tabs).getByRole('link', { name: 'Events' })).toHaveAttribute(
      'href',
      '/clusters/c1/events',
    );
    expect(within(tabs).getByRole('link', { name: 'Backups' })).toHaveAttribute(
      'href',
      '/clusters/c1/backups',
    );
    expect(within(tabs).getByText('Overview')).toHaveAttribute('aria-current', 'page');
  });

  it('explains an empty inventory instead of showing empty tables as if they were true', async () => {
    server(
      'OWNER',
      [cluster({ status: 'ENROLLED' })],
      overviewFor({
        cluster: cluster({ status: 'ENROLLED' }),
        inventory: { snapshotId: null, syncedAt: null, kinds: {} },
        locations: [],
        recentBackups: [],
        recentRestores: [],
      }),
    );
    renderApp({ path: '/clusters/c1' });
    expect(await screen.findByText('Waiting for the first inventory')).toBeVisible();
    expect(screen.getByText(/The agent is not connected yet/)).toBeVisible();
  });

  it('refreshes Velero status only while the agent is connected', async () => {
    const user = userEvent.setup();
    const fetchMock = server('OWNER', [cluster()], overviewFor());
    renderApp({ path: '/clusters/c1' });

    const button = await screen.findByRole('button', { name: 'Refresh Velero status' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) =>
          (typeof u === 'string' ? u : '').endsWith('/refresh-status') && i?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('disables the refresh, with the reason, when the agent is not connected', async () => {
    server(
      'OWNER',
      [cluster({ status: 'DISCONNECTED' })],
      overviewFor({ cluster: cluster({ status: 'DISCONNECTED' }) }),
    );
    renderApp({ path: '/clusters/c1' });
    const button = await screen.findByRole('button', { name: 'Refresh Velero status' });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/must be connected/);
  });
});
