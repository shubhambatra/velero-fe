import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { ClusterOverview } from '@/lib/fleet';
import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false };
const NOW = new Date().toISOString();

const CLUSTER = {
  id: 'c1',
  name: 'prod-eu',
  status: 'CONNECTED' as const,
  k8sVersion: 'v1.31.0',
  veleroVersion: 'v1.18.4',
  veleroPlugins: [],
  agentVersion: '0.1.0',
  chartVersion: '0.1.0',
  imageTag: '0.1.0',
  agentUpdateAvailable: false,
  agentPolicy: null,
  lastSeenAt: NOW,
  createdAt: NOW,
  labels: { env: 'prod', team: 'data' },
  grafanaUrlTemplate: 'https://grafana.example/d/abc?var-cluster={cluster}',
};

const overview = (cluster = CLUSTER): ClusterOverview => ({
  cluster,
  inventory: { snapshotId: 's1', syncedAt: NOW, kinds: {} },
  locations: [],
  recentBackups: [],
  recentRestores: [],
});

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function server(
  role: 'OWNER' | 'MEMBER',
  extra?: (url: string, init?: RequestInit) => Response | undefined,
) {
  const calls: Call[] = [];
  stubFetch((url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const custom = extra?.(url, init);
    if (custom !== undefined) return custom;
    if (url.endsWith('/auth/me')) return jsonResponse({ user: USER });
    if (url.endsWith('/me/orgs')) {
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: role, active: true }],
      });
    }
    if (url.endsWith('/overview')) return jsonResponse(overview());
    return jsonResponse({ status: 'ok' });
  });
  return calls;
}

describe('cluster Activity tab', () => {
  it('lists what was sent, how each command went, and why a failure failed', async () => {
    server('OWNER', (url) => {
      if (url.endsWith('/clusters/c1/commands')) {
        return jsonResponse({
          commands: [
            {
              id: 'k1',
              op: 'backup.create',
              status: 'SUCCEEDED',
              errorCode: null,
              errorMessage: null,
              attempts: 1,
              createdAt: '2026-10-16T01:00:00Z',
              finishedAt: '2026-10-16T01:00:02Z',
              deadlineAt: NOW,
            },
            {
              id: 'k2',
              op: 'restore.create',
              status: 'FAILED',
              errorCode: 'POLICY_DENIED',
              errorMessage: 'namespace kube-system is denied',
              attempts: 1,
              createdAt: '2026-10-16T02:00:00Z',
              finishedAt: '2026-10-16T02:00:01Z',
              deadlineAt: NOW,
            },
            {
              id: 'k3',
              op: 'refresh-status',
              status: 'SUCCEEDED',
              errorCode: null,
              errorMessage: null,
              attempts: 2,
              createdAt: '2026-10-16T03:00:00Z',
              finishedAt: null,
              deadlineAt: NOW,
            },
          ],
        });
      }
      return undefined;
    });
    renderApp({ path: '/clusters/c1/activity' });

    expect(await screen.findByText('backup create')).toBeVisible();
    expect(screen.getByText('FAILED')).toBeVisible();
    expect(screen.getByText(/namespace kube-system is denied/)).toBeVisible();
    expect(screen.getByText('POLICY_DENIED')).toBeVisible();
    expect(screen.getByText('2.0 s')).toBeVisible();
    expect(screen.getByText('delivered 2 times')).toBeVisible();
    // The tab strip marks where you are.
    const tabs = screen.getByRole('navigation', { name: 'Cluster sections' });
    expect(within(tabs).getByText('Activity')).toHaveAttribute('aria-current', 'page');
  });

  it('explains an empty history', async () => {
    server('OWNER', (url) =>
      url.endsWith('/commands') ? jsonResponse({ commands: [] }) : undefined,
    );
    renderApp({ path: '/clusters/c1/activity' });
    expect(await screen.findByText(/Nothing has been sent to this cluster yet/)).toBeVisible();
  });
});

describe('cluster Access tab', () => {
  const BINDING = {
    id: 'b1',
    subjectType: 'TEAM',
    subjectId: 't1',
    subjectName: 'platform',
    role: 'OPERATOR',
    scope: { type: 'NAMESPACES', namespaces: ['shop', 'billing'] },
    createdAt: NOW,
  };
  const lists = (url: string): Response | undefined => {
    if (url.endsWith('/clusters/c1/role-bindings')) return jsonResponse({ bindings: [BINDING] });
    if (url.endsWith('/orgs/o1/members')) {
      return jsonResponse({
        members: [
          {
            userId: 'u9',
            email: 'dev@acme.test',
            name: null,
            orgRole: 'MEMBER',
            mfaEnabled: true,
            joinedAt: NOW,
          },
        ],
      });
    }
    if (url.endsWith('/orgs/o1/teams')) {
      return jsonResponse({
        teams: [{ id: 't1', name: 'platform', description: null, memberCount: 3 }],
      });
    }
    return undefined;
  };

  it('shows who has which role where', async () => {
    server('OWNER', lists);
    renderApp({ path: '/clusters/c1/access' });

    const row = (await screen.findByText('platform', { selector: 'td' })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('Operator')).toBeVisible();
    expect(within(row).getByText('namespaces: shop, billing')).toBeVisible();
    expect(within(row).getByText('team')).toBeVisible();
  });

  it('grants a role over some namespaces to a person', async () => {
    const user = userEvent.setup();
    const calls = server('OWNER', (url, init) => {
      if (url.endsWith('/clusters/c1/role-bindings') && init?.method === 'POST')
        return jsonResponse({ id: 'b2' }, { status: 201 });
      return lists(url);
    });
    renderApp({ path: '/clusters/c1/access' });

    await screen.findByRole('option', { name: 'dev@acme.test' });
    await user.selectOptions(screen.getByLabelText('Person or team'), 'USER:u9');
    await user.selectOptions(screen.getByLabelText('Role'), 'RESTORER');
    await user.selectOptions(screen.getByLabelText('Applies to'), 'NAMESPACES');
    await user.type(screen.getByLabelText('Namespaces'), 'shop, billing');
    await user.click(screen.getByRole('button', { name: 'Grant role' }));

    await waitFor(() => {
      expect(
        calls.find((c) => c.method === 'POST' && c.url.endsWith('/role-bindings'))?.body,
      ).toEqual({
        subjectType: 'USER',
        subjectId: 'u9',
        role: 'RESTORER',
        scope: { type: 'NAMESPACES', namespaces: ['shop', 'billing'] },
      });
    });
  });

  it('does not offer a grant until someone is chosen, and revokes a binding', async () => {
    const user = userEvent.setup();
    const calls = server('OWNER', (url, init) => {
      if (url.endsWith('/role-bindings/b1') && init?.method === 'DELETE')
        return new Response(null, { status: 204 });
      return lists(url);
    });
    renderApp({ path: '/clusters/c1/access' });

    expect(await screen.findByRole('button', { name: 'Grant role' })).toBeDisabled();
    await user.click(await screen.findByRole('button', { name: 'Revoke platform' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/role-bindings/b1'))).toBe(
        true,
      );
    });
  });

  it('says why when you may not manage access', async () => {
    server('MEMBER', (url) =>
      url.endsWith('/role-bindings')
        ? jsonResponse(
            {
              type: 'about:blank',
              title: 'Forbidden',
              status: 403,
              detail: 'you need cluster:manage',
            },
            { status: 403 },
          )
        : lists(url),
    );
    renderApp({ path: '/clusters/c1/access' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/cluster:manage|Forbidden/);
  });
});

describe('cluster Settings tab', () => {
  it('saves the name, labels and Grafana link', async () => {
    const user = userEvent.setup();
    const calls = server('OWNER', (_url, init) =>
      init?.method === 'PATCH' ? jsonResponse({ ...CLUSTER, name: 'prod-eu-1' }) : undefined,
    );
    renderApp({ path: '/clusters/c1/settings' });

    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('prod-eu');
    expect(screen.getByLabelText('Labels')).toHaveValue('env=prod\nteam=data');
    await user.clear(name);
    await user.type(name, 'prod-eu-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        name: 'prod-eu-1',
        labels: { env: 'prod', team: 'data' },
        grafanaUrlTemplate: 'https://grafana.example/d/abc?var-cluster={cluster}',
      });
    });
    expect(await screen.findByText('Saved.')).toBeVisible();
  });

  it('clears the Grafana link with an empty field, and refuses a bad label before asking the server', async () => {
    const user = userEvent.setup();
    const calls = server('OWNER', (_url, init) =>
      init?.method === 'PATCH' ? jsonResponse({}) : undefined,
    );
    renderApp({ path: '/clusters/c1/settings' });

    const labels = await screen.findByLabelText('Labels');
    await user.clear(labels);
    await user.type(labels, 'broken');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Line 1 is not key=value.')).toBeVisible();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    await user.clear(labels);
    await user.clear(screen.getByLabelText('Grafana URL template'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
        labels: {},
        grafanaUrlTemplate: null,
      });
    });
  });

  it('adds a Grafana link to the cluster header from the template', async () => {
    server('OWNER');
    renderApp({ path: '/clusters/c1/settings' });
    const link = await screen.findByRole('link', { name: /Metrics in Grafana/ });
    expect(link).toHaveAttribute('href', 'https://grafana.example/d/abc?var-cluster=prod-eu');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('will not delete until the name is typed, then removes the cluster', async () => {
    const user = userEvent.setup();
    const calls = server('OWNER', (url, init) =>
      init?.method === 'DELETE' && url.endsWith('/clusters/c1')
        ? new Response(null, { status: 204 })
        : undefined,
    );
    renderApp({ path: '/clusters/c1/settings' });

    await user.click(await screen.findByRole('button', { name: 'Delete…' }));
    const confirm = screen.getByRole('button', { name: 'Delete cluster' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Type prod-eu to confirm'), 'prod-eu');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/clusters/c1'))).toBe(true);
    });
  });

  it('shows credentials actions only to administrators and disables the form for everyone else', async () => {
    server('MEMBER');
    renderApp({ path: '/clusters/c1/settings' });
    expect(await screen.findByLabelText('Name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/Only organization Owners and Admins can change these/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate certificate…' })).toBeNull();
  });
});
