import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false };
const TOKEN = 'T'.repeat(43);
const COMMAND = `helm install vfm-agent oci://example/vfm-agent \\\n  --set enrollment.token=${TOKEN}`;

interface State {
  clusters: { id: string; name: string; status: string }[];
  calls: string[];
}

const row = (c: { id: string; name: string; status: string }) => ({
  ...c,
  k8sVersion: null,
  veleroVersion: 'v1.18.4',
  agentVersion: null,
  lastSeenAt: null,
});

function server(role: 'OWNER' | 'MEMBER', state: State) {
  return stubFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/auth/me')) {
      return jsonResponse({ user: USER });
    }
    if (url.endsWith('/me/orgs')) {
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: role, active: true }],
      });
    }
    if (url.endsWith('/orgs/o1/clusters') && method === 'POST') {
      state.calls.push('create');
      state.clusters.push({ id: 'c1', name: 'prod-eu', status: 'PENDING' });
      return jsonResponse(
        {
          cluster: row({ id: 'c1', name: 'prod-eu', status: 'PENDING' }),
          bootstrapToken: TOKEN,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          installCommand: COMMAND,
        },
        { status: 201 },
      );
    }
    if (url.endsWith('/orgs/o1/clusters')) {
      return jsonResponse({ clusters: state.clusters.map(row) });
    }
    if (method === 'DELETE') {
      state.calls.push(`delete ${url}`);
      state.clusters = [];
      return new Response(null, { status: 204 });
    }
    if (url.includes('/clusters/c1/') && method === 'POST') {
      state.calls.push(url.split('/clusters/c1/')[1] ?? '');
      return jsonResponse({
        bootstrapToken: TOKEN,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        installCommand: COMMAND,
      });
    }
    return jsonResponse({ status: 'ok' });
  });
}

describe('Clusters page', () => {
  it('shows the install command once, keeps it out of storage, and lists the new cluster', async () => {
    const user = userEvent.setup();
    server('OWNER', { clusters: [], calls: [] });
    renderApp({ path: '/clusters' });

    await user.type(await screen.findByLabelText('Cluster name'), 'prod-eu');
    await user.click(screen.getByRole('button', { name: 'Add cluster' }));

    const command = await screen.findByLabelText('Install command');
    expect(command.textContent).toContain(`enrollment.token=${TOKEN}`);
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        expect(store.getItem(store.key(i) ?? '') ?? '').not.toContain(TOKEN);
      }
    }

    await user.click(screen.getByRole('button', { name: 'I have run it' }));
    expect(screen.queryByLabelText('Install command')).toBeNull();
    expect(await screen.findByText('pending')).toBeVisible();
  });

  it('gives a member the list but no way to add, mint or delete', async () => {
    server('MEMBER', { clusters: [{ id: 'c1', name: 'prod-eu', status: 'CONNECTED' }], calls: [] });
    renderApp({ path: '/clusters' });

    expect(await screen.findByText('prod-eu')).toBeVisible();
    expect(screen.getByText('connected')).toBeVisible();
    expect(screen.queryByLabelText('Cluster name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add cluster' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
  });

  it('tells a member with nothing shared how to get access, not to add one', async () => {
    server('MEMBER', { clusters: [], calls: [] });
    renderApp({ path: '/clusters' });
    expect(await screen.findByText(/No clusters are shared with you yet/)).toBeVisible();
  });

  it('will not delete until the cluster name is typed exactly', async () => {
    const user = userEvent.setup();
    const state: State = {
      clusters: [{ id: 'c1', name: 'prod-eu', status: 'ENROLLED' }],
      calls: [],
    };
    server('OWNER', state);
    renderApp({ path: '/clusters' });

    await user.click(await screen.findByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Cluster name'), 'prod-e');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Cluster name'), 'u');
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(await screen.findByText(/No clusters yet/)).toBeVisible();
    expect(state.calls.some((c) => c.startsWith('delete'))).toBe(true);
  });

  it('rotating a certificate asks first, then shows the new token', async () => {
    const user = userEvent.setup();
    const state: State = {
      clusters: [{ id: 'c1', name: 'prod-eu', status: 'CONNECTED' }],
      calls: [],
    };
    server('OWNER', state);
    renderApp({ path: '/clusters' });

    await user.click(await screen.findByRole('button', { name: 'Rotate certificate…' }));
    expect(state.calls).toEqual([]);

    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm' }),
    );
    expect(await screen.findByLabelText('Install command')).toBeVisible();
    expect(state.calls).toEqual(['rotate-certificate']);
  });

  it('offers Enable, not token or rotate, for a disabled cluster', async () => {
    server('OWNER', {
      clusters: [{ id: 'c1', name: 'prod-eu', status: 'DISABLED' }],
      calls: [],
    });
    renderApp({ path: '/clusters' });

    expect(await screen.findByRole('button', { name: 'Enable' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New token' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate certificate…' })).toBeNull();
  });
});
