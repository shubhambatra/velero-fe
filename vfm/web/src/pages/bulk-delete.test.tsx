import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false };
const NOW = new Date().toISOString();

const backup = (name: string, phase = 'Completed') => ({
  name,
  phase,
  startedAt: NOW,
  completedAt: NOW,
  expiresAt: NOW,
  createdByVfm: false,
  schedule: null,
  storageLocation: 'default',
  ttl: '720h0m0s',
  scope: { all: true, namespaces: [], more: 0 },
  includesClusterResources: false,
  warnings: 0,
  errors: 0,
  itemsBackedUp: 1,
  totalItems: 1,
  volumeSnapshots: { attempted: null, completed: null },
  failureReason: null,
});

function server(refuse: string[] = [], items = [backup('a'), backup('b'), backup('c')]) {
  const deleted: string[] = [];
  stubFetch((url, init) => {
    if (url.endsWith('/auth/me')) return jsonResponse({ user: USER });
    if (url.endsWith('/me/orgs')) {
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'OWNER', active: true }],
      });
    }
    if (url.endsWith('/overview')) {
      return jsonResponse({
        cluster: { id: 'c1', name: 'prod-eu', status: 'CONNECTED' },
        inventory: { snapshotId: 's', syncedAt: null, kinds: {} },
        locations: null,
        recentBackups: null,
        recentRestores: null,
      });
    }
    if (init?.method === 'DELETE' && url.includes('/backups/')) {
      const name = decodeURIComponent(url.split('/backups/')[1] ?? '');
      if (refuse.includes(name)) {
        return jsonResponse(
          { title: 'Forbidden', status: 403, detail: 'not yours' },
          { status: 403 },
        );
      }
      deleted.push(name);
      return jsonResponse({ id: `cmd-${name}` }, { status: 202 });
    }
    if (url.includes('/clusters/c1/backups')) return jsonResponse({ items, nextCursor: null });
    return jsonResponse({ status: 'ok' });
  });
  return deleted;
}

describe('bulk delete of backups', () => {
  it('offers no action until something is selected, then counts the selection', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/backups' });

    await screen.findByRole('link', { name: 'a' });
    expect(screen.queryByText(/selected/)).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Select a' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select c' }));
    expect(screen.getByText('2 selected')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete 2 selected…' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('selects every row on the page from the header', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/backups' });
    await screen.findByRole('link', { name: 'a' });
    await user.click(screen.getByRole('checkbox', { name: 'Select all backups on this page' }));
    expect(screen.getByText('3 selected')).toBeVisible();
  });

  it('needs the count typed, then deletes exactly the selected backups, one request each', async () => {
    const user = userEvent.setup();
    const deleted = server();
    renderApp({ path: '/clusters/c1/backups' });

    await screen.findByRole('link', { name: 'a' });
    await user.click(screen.getByRole('checkbox', { name: 'Select a' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select b' }));
    await user.click(screen.getByRole('button', { name: 'Delete 2 selected…' }));

    const confirm = screen.getByRole('button', { name: 'Delete 2 backups' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Type delete 2 backups to confirm'), 'delete 2 backups');
    await user.click(confirm);

    expect(await screen.findByRole('status', { name: 'Bulk deletion result' })).toHaveTextContent(
      'Deletion was requested for 2 backups',
    );
    expect(deleted.sort()).toEqual(['a', 'b']);
    // The selection is spent: nothing is left selected to be deleted by accident.
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('says exactly which were refused instead of reporting a clean success', async () => {
    const user = userEvent.setup();
    const deleted = server(['b']);
    renderApp({ path: '/clusters/c1/backups' });

    await screen.findByRole('link', { name: 'a' });
    await user.click(screen.getByRole('checkbox', { name: 'Select all backups on this page' }));
    await user.click(screen.getByRole('button', { name: 'Delete 3 selected…' }));
    await user.type(screen.getByLabelText('Type delete 3 backups to confirm'), 'delete 3 backups');
    await user.click(screen.getByRole('button', { name: 'Delete 3 backups' }));

    const note = await screen.findByRole('status', { name: 'Bulk deletion result' });
    await waitFor(() => {
      expect(note).toHaveTextContent('Deletion was requested for 2 backups');
    });
    expect(note).toHaveTextContent('1 were refused');
    expect(note).toHaveTextContent('b:');
    expect(deleted.sort()).toEqual(['a', 'c']);
  });

  it('leaves out a backup that is already being deleted', async () => {
    const user = userEvent.setup();
    const deleted = server([], [backup('a'), backup('gone', 'Deleting')]);
    renderApp({ path: '/clusters/c1/backups' });

    await screen.findByRole('link', { name: 'a' });
    await user.click(screen.getByRole('checkbox', { name: 'Select all backups on this page' }));
    expect(screen.getByRole('button', { name: 'Delete 1 selected…' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Delete 1 selected…' }));
    const dialog = screen.getByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Type delete 1 backups to confirm'),
      'delete 1 backups',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete 1 backups' }));
    await screen.findByRole('status', { name: 'Bulk deletion result' });
    expect(deleted).toEqual(['a']);
  });
});
