import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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

const ALL: Record<string, string> = {
  'backup:create': 'cluster',
  'backup:delete': 'cluster',
  'advanced:write': 'cluster',
  'schedule:write': 'cluster',
};
const SCOPED: Record<string, string> = {
  'backup:create': 'scoped',
  'backup:delete': 'none',
  'advanced:write': 'none',
};
const NONE: Record<string, string> = { 'backup:create': 'none', 'backup:delete': 'none' };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const BACKUP = {
  summary: {
    name: 'nightly-1',
    phase: 'Completed',
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    createdByVfm: false,
    schedule: null,
    storageLocation: null,
    ttl: null,
    scope: { all: true, namespaces: [], more: 0 },
    includesClusterResources: false,
    warnings: 0,
    errors: 0,
    itemsBackedUp: null,
    totalItems: null,
    volumeSnapshots: { attempted: null, completed: null },
    failureReason: null,
  },
  timeline: [],
  labels: {},
  spec: {},
  status: {},
  yaml: '',
  volumes: [],
};

function server(
  options: {
    access?: Record<string, string>;
    post?: (path: string, body: unknown) => Response;
    command?: () => unknown;
    backup?: unknown;
    schedules?: unknown[];
  } = {},
) {
  const calls: Call[] = [];
  stubFetch((url, init) => {
    const method = init?.method ?? 'GET';
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
    if (rest === 'access') return jsonResponse({ access: options.access ?? ALL });
    if (rest.startsWith('backup-locations'))
      return jsonResponse({
        items: [{ name: 'default', isDefault: true }, { name: 'archive' }],
        nextCursor: null,
      });
    if (rest.startsWith('snapshot-locations'))
      return jsonResponse({ items: [{ name: 'aws' }], nextCursor: null });
    if (rest.startsWith('commands/'))
      return jsonResponse(options.command?.() ?? { id: 'k1', status: 'QUEUED' });
    if (rest === 'schedules')
      return jsonResponse({ items: options.schedules ?? [], nextCursor: null });
    if (rest === 'backups' && method === 'GET')
      return jsonResponse({ items: [], nextCursor: null });
    if (rest.startsWith('backups/') && method === 'GET')
      return jsonResponse(options.backup ?? BACKUP);
    if (method !== 'GET') {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: rest, body });
      return (
        options.post?.(rest, body) ?? jsonResponse({ id: 'k1', status: 'QUEUED' }, { status: 202 })
      );
    }
    return jsonResponse({ items: [], nextCursor: null });
  });
  return calls;
}

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ title: 'Problem', status, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

const preview = () => screen.getByLabelText('Equivalent velero command').textContent;
const next = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Next' }));
};

describe('the backup wizard', () => {
  it('walks through the steps and sends what was entered', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/backups/new' });

    expect(await screen.findByRole('heading', { name: 'What to back up' })).toBeVisible();
    await user.type(screen.getByLabelText('Name'), 'nightly-1');
    await user.type(screen.getByLabelText('Namespaces to include'), 'shop,cart');
    await next(user);

    expect(await screen.findByRole('heading', { name: 'Storage and volumes' })).toBeVisible();
    // The storage locations come from the cluster's inventory.
    await user.selectOptions(screen.getByLabelText('Storage location'), 'archive');
    await user.selectOptions(screen.getByLabelText('Snapshot volumes'), 'No');
    await next(user);

    expect(await screen.findByRole('heading', { name: 'Options' })).toBeVisible();
    await user.type(screen.getByLabelText('Keep for'), '72h');
    await next(user);

    expect(await screen.findByRole('heading', { name: 'Review' })).toBeVisible();
    expect(JSON.parse(screen.getByLabelText('Request').textContent)).toEqual({
      name: 'nightly-1',
      includedNamespaces: ['shop', 'cart'],
      storageLocation: 'archive',
      snapshotVolumes: false,
      ttl: '72h',
    });

    await user.click(screen.getByRole('button', { name: 'Create backup' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: 'backups',
      body: {
        name: 'nightly-1',
        includedNamespaces: ['shop', 'cart'],
        storageLocation: 'archive',
        snapshotVolumes: false,
        ttl: '72h',
      },
    });
    // Back on the list, with a notification following the command.
    expect(await screen.findByRole('region', { name: 'Notifications' })).toBeVisible();
    expect(await screen.findByText('Create backup nightly-1')).toBeVisible();
  });

  it('shows the equivalent command and keeps it current', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });

    expect(preview()).toBe('velero backup create <name>');
    await user.type(screen.getByLabelText('Name'), 'x');
    await user.type(screen.getByLabelText('Namespaces to include'), 'shop');
    await user.selectOptions(screen.getByLabelText('Cluster-scoped resources'), 'No');
    expect(preview()).toBe(
      'velero backup create x --include-namespaces shop --include-cluster-resources=false',
    );

    await user.type(screen.getByLabelText('Label selector'), 'app=web');
    expect(preview()).toContain('--selector app=web');
  });

  it('copes with a browser that will not copy', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });
    vi.stubGlobal('navigator', { clipboard: undefined });
    await user.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(await screen.findByText(/Could not copy/)).toBeVisible();
    vi.unstubAllGlobals();
  });

  it('stops at a mistake, says where it is, and clears it once fixed', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });

    await user.type(screen.getByLabelText('Namespaces to include'), 'dev*');
    await next(user);
    expect(screen.getByRole('heading', { name: 'What to back up' })).toBeVisible();
    const field = screen.getByLabelText('Namespaces to include');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(/not a namespace name/);

    await user.clear(field);
    await user.type(field, 'dev');
    expect(screen.queryByRole('alert')).toBeNull();
    await next(user);
    expect(await screen.findByRole('heading', { name: 'Storage and volumes' })).toBeVisible();
  });

  it('sends the user back to the step with the problem when creating', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });
    await next(user);
    await next(user);
    await user.type(screen.getByLabelText('Keep for'), 'soon');
    // Step 3 is reachable with an error inside the step itself only after Next fails.
    await next(user);
    expect(screen.getByRole('heading', { name: 'Options' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/duration/);
    expect(calls).toHaveLength(0);
  });

  it('shows the server’s refusal and keeps the form', async () => {
    const user = userEvent.setup();
    server({ post: () => problem(403, 'missing permission backup:create') });
    renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });
    await user.type(screen.getByLabelText('Name'), 'keep-me');
    await next(user);
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Create backup' }));

    expect(await screen.findByText(/missing permission backup:create/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Review' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Name')).toHaveValue('keep-me');
  });

  describe('for a user limited to some namespaces', () => {
    it('starts with cluster-scoped resources off and cannot change that', async () => {
      const user = userEvent.setup();
      server({ access: SCOPED });
      renderApp({ path: '/clusters/c1/backups/new' });
      await screen.findByText(/Your access covers only some namespaces/);

      const select = screen.getByLabelText('Cluster-scoped resources');
      expect(select).toBeDisabled();
      expect(select).toHaveValue('no');
      await waitFor(() => {
        expect(preview()).toContain('--include-cluster-resources=false');
      });

      await next(user);
      expect(screen.getByRole('alert')).toHaveTextContent(/name each namespace/);
      await user.type(screen.getByLabelText('Namespaces to include'), 'dev');
      await next(user);
      expect(await screen.findByRole('heading', { name: 'Storage and volumes' })).toBeVisible();
    });

    it('cannot use the advanced settings', async () => {
      const user = userEvent.setup();
      server({ access: SCOPED });
      renderApp({ path: '/clusters/c1/backups/new' });
      await screen.findByText(/Your access covers only some namespaces/);
      await user.type(screen.getByLabelText('Namespaces to include'), 'dev');
      await next(user);
      await next(user);
      expect(screen.getByLabelText('Advanced settings (JSON)')).toBeDisabled();
      expect(screen.getByText(/Only administrators of the whole cluster/)).toBeVisible();
    });
  });

  it('explains instead of showing a form to someone who may not create backups', async () => {
    server({ access: NONE });
    renderApp({ path: '/clusters/c1/backups/new' });
    expect(await screen.findByText('You cannot create backups here')).toBeVisible();
    expect(screen.queryByLabelText('Namespaces to include')).toBeNull();
  });

  it('lets a cluster administrator add advanced settings, checked as JSON', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });
    await next(user);
    await next(user);
    const area = screen.getByLabelText('Advanced settings (JSON)');
    expect(area).toBeEnabled();
    await user.click(area);
    await user.paste('{"hooks":');
    await next(user);
    expect(screen.getByRole('alert')).toHaveTextContent('Not valid JSON');
    await user.clear(area);
    await user.click(area);
    await user.paste('{"snapshotVolumes":true}');
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Create backup' }));
    await waitFor(() => {
      expect(calls[0]?.body).toEqual({ advancedSpec: { snapshotVolumes: true } });
    });
  });
});

describe('the backups list entry points', () => {
  it('offers Create backup to whoever may, and a disabled one with the reason to whoever may not', async () => {
    server();
    const { unmount } = renderApp({ path: '/clusters/c1/backups' });
    expect(await screen.findByRole('link', { name: 'Create backup' })).toHaveAttribute(
      'href',
      '/clusters/c1/backups/new',
    );
    unmount();

    server({ access: NONE });
    renderApp({ path: '/clusters/c1/backups' });
    const button = await screen.findByRole('button', { name: 'Create backup' });
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    expect(button.getAttribute('title')).toMatch(/backup:create/);
  });
});

describe('deleting a backup', () => {
  it('asks for the name, then asks the server, then follows the command', async () => {
    const user = userEvent.setup();
    const calls = server({
      command: () => ({
        id: 'k1',
        status: 'SUCCEEDED',
        errorMessage: null,
        result: { kind: 'DeleteBackupRequest', name: 'x' },
      }),
    });
    renderApp({ path: '/clusters/c1/backups/nightly-1' });
    await user.click(await screen.findByRole('button', { name: 'Delete backup' }));

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete backup' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Type nightly-1 to confirm'), 'nightly-');
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Type nightly-1 to confirm'), '1');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => {
      expect(calls).toEqual([{ method: 'DELETE', path: 'backups/nightly-1', body: undefined }]);
    });
    expect(await screen.findByText('Delete backup nightly-1')).toBeVisible();
    expect(await screen.findByText(/Velero is removing the backup/)).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('can be cancelled with the keyboard, and sends nothing', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/backups/nightly-1' });
    await user.click(await screen.findByRole('button', { name: 'Delete backup' }));
    expect(await screen.findByRole('dialog')).toBeVisible();
    expect(screen.getByLabelText('Type nightly-1 to confirm')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('keeps the dialog open and says why when the server refuses', async () => {
    const user = userEvent.setup();
    server({ post: () => problem(403, 'recent re-authentication required') });
    renderApp({ path: '/clusters/c1/backups/nightly-1' });
    await user.click(await screen.findByRole('button', { name: 'Delete backup' }));
    await user.type(await screen.findByLabelText('Type nightly-1 to confirm'), 'nightly-1');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete backup' }),
    );
    expect(await screen.findByText(/recent re-authentication required/)).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('is disabled with the reason when the user may not delete, or it is already going', async () => {
    server({ access: NONE });
    const { unmount } = renderApp({ path: '/clusters/c1/backups/nightly-1' });
    const button = await screen.findByRole('button', { name: 'Delete backup' });
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    expect(button.getAttribute('title')).toMatch(/backup:delete/);
    unmount();

    server({ backup: { ...BACKUP, summary: { ...BACKUP.summary, phase: 'Deleting' } } });
    renderApp({ path: '/clusters/c1/backups/nightly-1' });
    const going = await screen.findByRole('button', { name: 'Delete backup' });
    expect(going).toBeDisabled();
    expect(going.getAttribute('title')).toMatch(/already being deleted/);
  });
});

describe('running a schedule now', () => {
  const schedule = {
    name: 'nightly',
    phase: 'Enabled',
    createdByVfm: false,
    cron: '0 2 * * *',
    paused: false,
    lastBackup: null,
    storageLocation: null,
    ttl: null,
    scope: { all: true, namespaces: [], more: 0 },
    validationErrors: [],
  };

  it('asks the server to run it and follows the command', async () => {
    const user = userEvent.setup();
    const calls = server({ schedules: [schedule] });
    renderApp({ path: '/clusters/c1/schedules' });
    await user.click(await screen.findByRole('button', { name: 'Run nightly now' }));
    await waitFor(() => {
      expect(calls).toEqual([{ method: 'POST', path: 'schedules/nightly/trigger', body: {} }]);
    });
    expect(await screen.findByText('Run schedule nightly now')).toBeVisible();
  });

  it('says what the server said when it refuses', async () => {
    const user = userEvent.setup();
    server({ schedules: [schedule], post: () => problem(403, 'missing permission backup:create') });
    renderApp({ path: '/clusters/c1/schedules' });
    await user.click(await screen.findByRole('button', { name: 'Run nightly now' }));
    expect(await screen.findByText(/missing permission backup:create/)).toBeVisible();
  });

  it('is disabled with the reason for someone who may not', async () => {
    server({ schedules: [schedule], access: NONE });
    renderApp({ path: '/clusters/c1/schedules' });
    const button = await screen.findByRole('button', { name: 'Run nightly now' });
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
  });
});

describe('the notification that follows a command', () => {
  it('shows the failure and stays until dismissed', async () => {
    const user = userEvent.setup();
    server({
      command: () => ({
        id: 'k1',
        status: 'FAILED',
        errorMessage: 'this agent is in read-only mode',
        result: null,
      }),
    });
    renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });
    await next(user);
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Create backup' }));

    expect(await screen.findByText(/Failed: this agent is in read-only mode/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/read-only mode/)).toBeNull();
  });

  it('links to the new backup when it succeeds', async () => {
    const user = userEvent.setup();
    server({
      command: () => ({
        id: 'k1',
        status: 'SUCCEEDED',
        errorMessage: null,
        result: { kind: 'Backup', name: 'backup-20261016' },
      }),
    });
    renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });
    await next(user);
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(await screen.findByRole('link', { name: 'Open backup-20261016' })).toHaveAttribute(
      'href',
      '/clusters/c1/backups/backup-20261016',
    );
  });

  it('links to a new restore, and explains a deleted one', async () => {
    const user = userEvent.setup();
    server({
      command: () => ({
        id: 'k1',
        status: 'SUCCEEDED',
        errorMessage: null,
        result: { kind: 'Restore', name: 'r-1' },
      }),
    });
    const first = renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });
    await next(user);
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(await screen.findByRole('link', { name: 'Open r-1' })).toHaveAttribute(
      'href',
      '/clusters/c1/restores/r-1',
    );
    first.unmount();

    server({
      command: () => ({
        id: 'k2',
        status: 'SUCCEEDED',
        errorMessage: null,
        result: { kind: 'DeletedRestore', name: 'r-1' },
      }),
    });
    renderApp({ path: '/clusters/c1/backups/new' });
    await screen.findByRole('heading', { name: 'What to back up' });
    await next(user);
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText(/What it restored stays in the cluster/)).toBeVisible();
  });
});
