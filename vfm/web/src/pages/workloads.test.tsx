import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FakeEventSource } from '@/test/event-source';
import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false };
const CLUSTER = {
  id: 'c1',
  name: 'prod-eu',
  status: 'CONNECTED',
  k8sVersion: null,
  veleroVersion: 'v1.18.4',
  veleroPlugins: [],
  agentVersion: '0.1.0',
  chartVersion: null,
  imageTag: null,
  agentUpdateAvailable: false,
  agentPolicy: null,
  lastSeenAt: null,
  createdAt: '2026-10-16T00:00:00Z',
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const NAMESPACES = [
  {
    name: 'shop',
    phase: 'Active',
    labels: {},
    createdAt: null,
    coverage: {
      state: 'recent',
      lastBackupAt: hoursAgo(3),
      lastBackupName: 'shop-nightly-1',
      scheduled: true,
    },
  },
  {
    name: 'billing',
    phase: 'Active',
    labels: {},
    createdAt: null,
    coverage: {
      state: 'stale',
      lastBackupAt: hoursAgo(100),
      lastBackupName: null,
      scheduled: false,
    },
  },
  {
    name: 'scratch',
    phase: 'Active',
    labels: {},
    createdAt: null,
    coverage: { state: 'none', lastBackupAt: null, lastBackupName: null, scheduled: false },
  },
];
const POD = {
  namespace: 'shop',
  name: 'web-1',
  phase: 'Running',
  reason: null,
  ready: '1/2',
  restarts: 8,
  node: 'n1',
  owner: { kind: 'ReplicaSet', name: 'web-abc' },
  startedAt: hoursAgo(5),
  containers: [
    {
      name: 'app',
      image: 'nginx:1',
      ready: true,
      init: false,
      state: 'running',
      reason: '',
      restarts: 2,
      lastTerminationReason: 'OOMKilled',
    },
    {
      name: 'side',
      image: 'envoy:1',
      ready: false,
      init: false,
      state: 'waiting',
      reason: 'CrashLoopBackOff',
      restarts: 6,
      lastTerminationReason: null,
    },
  ],
};
const NODE = {
  name: 'n1',
  phase: 'Ready',
  roles: ['control-plane'],
  kubeletVersion: 'v1.31.0',
  allocatable: { cpu: '4', memory: '16Gi', pods: '110' },
  pressure: ['MemoryPressure'],
  schedulable: false,
  taints: [{ key: 'dedicated', value: 'db', effect: 'NoSchedule' }],
};
const PVC = {
  namespace: 'shop',
  name: 'data',
  phase: 'Bound',
  capacity: '10Gi',
  storageClass: 'fast',
  volume: 'pv-1',
};
const EVENT = {
  namespace: 'shop',
  name: 'warn-1',
  type: 'Warning',
  reason: 'BackOff',
  message: 'Back-off restarting failed container',
  count: 4,
  lastSeen: hoursAgo(0.2),
  object: { kind: 'Pod', name: 'web-1', namespace: 'shop' },
};

function server() {
  const requests: string[] = [];
  stubFetch((url) => {
    if (url.endsWith('/auth/me')) return jsonResponse({ user: USER });
    if (url.endsWith('/me/orgs'))
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'OWNER', active: true }],
      });
    if (url.endsWith('/overview'))
      return jsonResponse({
        cluster: CLUSTER,
        inventory: { snapshotId: 's', syncedAt: null, kinds: {} },
        locations: null,
        recentBackups: null,
        recentRestores: null,
      });
    const u = new URL(url, 'http://x');
    const rest = u.pathname.replace('/api/v1/orgs/o1/clusters/c1/', '');
    requests.push(rest + u.search);
    const page = (items: unknown[]) => jsonResponse({ items, nextCursor: null });
    switch (rest) {
      case 'inventory/namespaces':
        return page(NAMESPACES);
      case 'inventory/pods': {
        const ns = u.searchParams.get('namespace');
        return page(ns === null || ns === 'shop' ? [POD] : []);
      }
      case 'log-shortcuts':
        return jsonResponse({
          namespace: 'velero',
          server: [{ pod: 'velero-7d9', container: 'velero', node: 'n1' }],
          nodeAgent: [],
        });
      case 'inventory/nodes':
        return page([NODE]);
      case 'inventory/pvcs':
        return page([PVC]);
      case 'inventory/events':
        return page([EVENT]);
      default:
        return jsonResponse({ items: [], nextCursor: null });
    }
  });
  return requests;
}

describe('the workloads page', () => {
  it('shows each namespace with the last successful backup that covers it', async () => {
    server();
    renderApp({ path: '/clusters/c1/workloads' });
    const rows = await screen.findAllByRole('row');
    const row = (name: string) => rows.find((r) => within(r).queryByText(name) !== null);
    const shop = row('shop');
    expect(within(shop as HTMLElement).getByText('Backed up')).toBeVisible();
    expect(within(shop as HTMLElement).getByText('scheduled')).toBeVisible();
    expect(within(shop as HTMLElement).getByText(/shop-nightly-1/)).toBeVisible();
    expect(within(row('billing') as HTMLElement).getByText('Stale')).toBeVisible();
    expect(within(row('scratch') as HTMLElement).getByText('Never backed up')).toBeVisible();
  });

  it('opens the pods of a namespace from its row, filtered to it', async () => {
    const user = userEvent.setup();
    const requests = server();
    renderApp({ path: '/clusters/c1/workloads' });
    await user.click(await screen.findByRole('button', { name: 'Show pods in shop' }));
    expect(await screen.findByText('web-1')).toBeVisible();
    await waitFor(() => {
      expect(
        requests.some((r) => r.startsWith('inventory/pods') && r.includes('namespace=shop')),
      ).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Pods' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens a container’s live log from the pod list and closes it again', async () => {
    const user = userEvent.setup();
    FakeEventSource.install();
    const sent: { method: string; url: string; body: unknown }[] = [];
    const inner = vi.mocked(fetch);
    server();
    const base = vi.mocked(fetch).getMockImplementation();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/log-sessions') || /log-sessions\/[^/]+$/.test(url)) {
          sent.push({
            method: init?.method ?? 'GET',
            url,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
          });
          return Promise.resolve(
            init?.method === 'DELETE'
              ? new Response(null, { status: 204 })
              : jsonResponse({
                  sessionId: 's1',
                  streamUrl: 'log-sessions/s1/stream',
                  expiresAt: 'x',
                }),
          );
        }
        return base?.(input, init) ?? inner(input, init);
      }),
    );
    renderApp({ path: '/clusters/c1/workloads' });
    await user.click(await screen.findByRole('button', { name: 'Pods' }));
    await user.click(await screen.findByText('web-1'));
    await user.click(await screen.findByRole('button', { name: 'Logs of side in web-1' }));
    expect(await screen.findByRole('log', { name: 'Log output' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'shop/web-1 · side' })).toBeVisible();
    await waitFor(() => {
      expect(sent[0]?.body).toMatchObject({ namespace: 'shop', pod: 'web-1', container: 'side' });
    });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('log')).toBeNull();
    await waitFor(() => {
      expect(sent.some((c) => c.method === 'DELETE')).toBe(true);
    });
  });

  it('offers a one-click log of the Velero server on the pods view', async () => {
    const user = userEvent.setup();
    FakeEventSource.install();
    server();
    renderApp({ path: '/clusters/c1/workloads' });
    await user.click(await screen.findByRole('button', { name: 'Pods' }));
    expect(await screen.findByRole('button', { name: 'Velero server' })).toBeVisible();
  });

  it('drills from a pod into its containers', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/workloads' });
    await user.click(await screen.findByRole('button', { name: 'Pods' }));
    expect(await screen.findByText('1/2')).toBeVisible();
    await user.click(await screen.findByText('web-1'));
    expect(await screen.findByText('CrashLoopBackOff', { exact: false })).toBeVisible();
    expect(screen.getByText('OOMKilled')).toBeVisible();
    expect(screen.getByText('nginx:1')).toBeVisible();
    expect(screen.getByText('ReplicaSet/web-abc')).toBeVisible();
  });

  it('lists nodes with their state, cordon, pressure and taints', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/workloads' });
    await user.click(await screen.findByRole('button', { name: 'Nodes' }));
    expect(await screen.findByText('n1')).toBeVisible();
    expect(screen.getByText('cordoned')).toBeVisible();
    expect(screen.getByText('MemoryPressure')).toBeVisible();
    expect(screen.getByText('dedicated=db:NoSchedule')).toBeVisible();
    expect(screen.getByText('16Gi')).toBeVisible();
  });

  it('lists volume claims', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/workloads' });
    await user.click(await screen.findByRole('button', { name: 'Volume claims' }));
    expect(await screen.findByText('data')).toBeVisible();
    expect(screen.getByText('10Gi')).toBeVisible();
    expect(screen.getByText('pv-1')).toBeVisible();
  });
});

describe('the events page', () => {
  it('lists the last hour’s warnings and filters by type', async () => {
    const user = userEvent.setup();
    const requests = server();
    renderApp({ path: '/clusters/c1/events' });
    expect(await screen.findByText('Back-off restarting failed container')).toBeVisible();
    expect(screen.getByText('Pod/web-1')).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Phase'), 'Warning');
    await waitFor(() => {
      expect(
        requests.some((r) => r.startsWith('inventory/events') && r.includes('phase=Warning')),
      ).toBe(true);
    });
  });
});
