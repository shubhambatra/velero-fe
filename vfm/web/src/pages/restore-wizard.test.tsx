import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

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
  'restore:create': 'cluster',
  'advanced:write': 'cluster',
  'backup:create': 'cluster',
};
const SCOPED: Record<string, string> = { 'restore:create': 'scoped', 'advanced:write': 'none' };
const NONE: Record<string, string> = { 'restore:create': 'none' };

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
    report?: { name: string; exists: boolean; terminating: boolean }[];
    impactFails?: boolean;
    post?: (path: string, body: unknown) => Response | undefined;
    backup?: unknown;
    approval?: { required: boolean; fromOrg: boolean; fromCluster: boolean };
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
    if (rest === 'restore-approval')
      return jsonResponse(
        options.approval ?? { required: false, fromOrg: false, fromCluster: false },
      );
    if (rest.startsWith('commands/k-impact'))
      return jsonResponse(
        options.impactFails
          ? {
              id: 'k-impact',
              status: 'FAILED',
              errorMessage: 'the agent is not permitted to read namespaces',
              result: null,
            }
          : {
              id: 'k-impact',
              status: 'SUCCEEDED',
              errorMessage: null,
              result: { namespaces: options.report ?? [] },
            },
      );
    if (rest.startsWith('commands/'))
      return jsonResponse({
        id: 'k1',
        status: 'SUCCEEDED',
        errorMessage: null,
        result: { kind: 'Restore', name: 'r-1' },
      });
    if (rest.startsWith('backups?') || rest === 'backups')
      return jsonResponse({
        items: [
          { name: 'nightly-1', phase: 'Completed' },
          { name: 'weekly-1', phase: 'Completed' },
        ],
        nextCursor: null,
      });
    if (rest.startsWith('schedules'))
      return jsonResponse({ items: [{ name: 'nightly' }], nextCursor: null });
    if (rest.startsWith('backups/') && method === 'GET')
      return jsonResponse(options.backup ?? BACKUP);
    if (method !== 'GET') {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: rest, body });
      const custom = options.post?.(rest, body);
      if (custom !== undefined) return custom;
      return jsonResponse(
        { id: rest === 'restores/impact' ? 'k-impact' : 'k1', status: 'QUEUED' },
        { status: 202 },
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

describe('the restore wizard', () => {
  it('walks through the steps, shows the impact and sends what was entered', async () => {
    const user = userEvent.setup();
    const calls = server({
      report: [
        { name: 'shop-restored', exists: false, terminating: false },
        { name: 'cart', exists: true, terminating: false },
      ],
    });
    renderApp({ path: '/clusters/c1/restores/new' });

    expect(await screen.findByRole('heading', { name: 'Source' })).toBeVisible();
    await user.type(screen.getByLabelText('Backup'), 'nightly-1');
    await next(user);

    expect(await screen.findByRole('heading', { name: 'Scope' })).toBeVisible();
    await user.type(screen.getByLabelText('Namespaces to restore'), 'shop,cart');
    await user.type(screen.getByLabelText('Namespace mapping'), 'shop:shop-restored');
    await next(user);

    expect(await screen.findByRole('heading', { name: 'Options' })).toBeVisible();
    await user.selectOptions(screen.getByLabelText('When a resource already exists'), 'Update it');
    await next(user);

    expect(await screen.findByRole('heading', { name: 'Review' })).toBeVisible();
    const impact = await screen.findByRole('region', { name: 'Impact' });
    await waitFor(() => {
      expect(within(impact).getByText('Exists, updated')).toBeVisible();
    });
    expect(within(impact).getByText('New')).toBeVisible();
    expect(within(impact).getByText('shop-restored (renamed)')).toBeVisible();
    // Only the target names were asked about.
    expect(calls.find((c) => c.path === 'restores/impact')?.body).toEqual({
      namespaces: ['shop-restored', 'cart'],
    });

    await user.click(screen.getByRole('button', { name: 'Start restore' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === 'restores')).toBe(true);
    });
    expect(calls.find((c) => c.path === 'restores')?.body).toEqual({
      backupName: 'nightly-1',
      includedNamespaces: ['shop', 'cart'],
      namespaceMapping: { shop: 'shop-restored' },
      existingResourcePolicy: 'update',
    });
    expect(await screen.findByText('Restore from nightly-1')).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Open r-1' })).toHaveAttribute(
      'href',
      '/clusters/c1/restores/r-1',
    );
  });

  it('starts with the backup chosen when it is opened from a backup', async () => {
    server();
    renderApp({ path: '/clusters/c1/restores/new?backup=weekly-1' });
    await screen.findByRole('heading', { name: 'Source' });
    expect(screen.getByLabelText('Backup')).toHaveValue('weekly-1');
    expect(preview()).toBe('velero restore create <name> --from-backup weekly-1');
  });

  it('can restore from a schedule', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/restores/new?schedule=nightly' });
    await screen.findByRole('heading', { name: 'Source' });
    expect(screen.getByLabelText('Restore from')).toHaveValue('schedule');
    expect(preview()).toContain('--from-schedule nightly');
    await next(user);
    await user.type(screen.getByLabelText('Namespaces to restore'), 'shop');
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Start restore' }));
    await waitFor(() => {
      expect(calls.find((c) => c.path === 'restores')?.body).toEqual({
        scheduleName: 'nightly',
        includedNamespaces: ['shop'],
      });
    });
  });

  it('keeps the command current as the form changes', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/restores/new' });
    await screen.findByRole('heading', { name: 'Source' });
    await user.type(screen.getByLabelText('Backup'), 'b1');
    await next(user);
    await user.type(screen.getByLabelText('Namespaces to restore'), 'shop');
    await user.type(screen.getByLabelText('Namespace mapping'), 'shop:shop2');
    expect(preview()).toBe(
      'velero restore create <name> --from-backup b1 --include-namespaces shop --namespace-mappings shop:shop2',
    );
  });

  it('stops at a missing source and at a mapping that does nothing', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/restores/new' });
    await screen.findByRole('heading', { name: 'Source' });
    await next(user);
    expect(screen.getByRole('heading', { name: 'Source' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/Choose the backup/);

    await user.type(screen.getByLabelText('Backup'), 'b1');
    await next(user);
    await user.type(screen.getByLabelText('Namespaces to restore'), 'shop');
    await user.type(screen.getByLabelText('Namespace mapping'), 'cart:cart2');
    await next(user);
    expect(screen.getByRole('heading', { name: 'Scope' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/would do nothing/);
  });

  it('says it cannot list the namespaces of an "everything" restore, and still lets it go ahead', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/restores/new?backup=nightly-1' });
    await screen.findByRole('heading', { name: 'Source' });
    await next(user);
    await next(user);
    await next(user);
    expect(await screen.findByText(/cannot be listed in advance/)).toBeVisible();
    expect(calls.some((c) => c.path === 'restores/impact')).toBe(false);
    expect(screen.getByRole('button', { name: 'Start restore' })).toBeEnabled();
  });

  it('will not start a restore into a namespace that is being deleted', async () => {
    const user = userEvent.setup();
    server({ report: [{ name: 'shop', exists: true, terminating: true }] });
    renderApp({ path: '/clusters/c1/restores/new?backup=nightly-1' });
    await screen.findByRole('heading', { name: 'Source' });
    await next(user);
    await user.type(screen.getByLabelText('Namespaces to restore'), 'shop');
    await next(user);
    await next(user);
    expect(await screen.findByText('Being deleted')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start restore' })).toBeDisabled();
    expect(screen.getByText(/being deleted\. Wait until it is gone/)).toBeVisible();
  });

  it('says so when the cluster cannot be checked, offers another try, and still lets the restore go ahead', async () => {
    const user = userEvent.setup();
    const calls = server({ impactFails: true });
    renderApp({ path: '/clusters/c1/restores/new?backup=nightly-1' });
    await screen.findByRole('heading', { name: 'Source' });
    await next(user);
    await user.type(screen.getByLabelText('Namespaces to restore'), 'shop');
    await next(user);
    await next(user);
    expect(
      await screen.findByText(
        /Could not check the cluster: the agent is not permitted to read namespaces/,
      ),
    ).toBeVisible();
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start restore' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.path === 'restores/impact')).toHaveLength(2);
    });
  });

  it('shows the server’s refusal and keeps the form', async () => {
    const user = userEvent.setup();
    server({
      post: (path) =>
        path === 'restores' ? problem(403, 'recent re-authentication required') : undefined,
    });
    renderApp({ path: '/clusters/c1/restores/new?backup=nightly-1' });
    await screen.findByRole('heading', { name: 'Source' });
    await next(user);
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Start restore' }));
    expect(await screen.findByText(/recent re-authentication required/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Review' })).toBeVisible();
  });

  describe('when the cluster requires approval', () => {
    const REQUIRED = { required: true, fromOrg: false, fromCluster: true };

    it('says so before the request is made, and does not follow it as a running command', async () => {
      const user = userEvent.setup();
      const calls = server({
        approval: REQUIRED,
        post: (path) =>
          path === 'restores'
            ? jsonResponse({ id: 'k1', status: 'PENDING_APPROVAL' }, { status: 202 })
            : undefined,
      });
      renderApp({ path: '/clusters/c1/restores/new?backup=nightly-1' });
      await screen.findByRole('heading', { name: 'Source' });
      await next(user);
      await next(user);
      await next(user);
      expect(await screen.findByText(/This cluster requires approval/)).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Request restore' }));
      await waitFor(() => {
        expect(calls.some((c) => c.path === 'restores')).toBe(true);
      });
      expect(await screen.findByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
      expect(screen.getByRole('link', { name: 'Go to approvals' })).toHaveAttribute(
        'href',
        '/approvals',
      );
      expect(screen.queryByText('Restore from nightly-1')).toBeNull();
      expect(screen.queryByRole('button', { name: /restore$/i })).toBeNull();
    });

    it('says nothing of the kind when approval is not required', async () => {
      const user = userEvent.setup();
      server();
      renderApp({ path: '/clusters/c1/restores/new?backup=nightly-1' });
      await screen.findByRole('heading', { name: 'Source' });
      await next(user);
      await next(user);
      await next(user);
      expect(await screen.findByRole('button', { name: 'Start restore' })).toBeVisible();
      expect(screen.queryByText(/requires approval/)).toBeNull();
    });
  });

  describe('for a user limited to some namespaces', () => {
    it('starts with cluster-scoped resources off and requires named namespaces', async () => {
      const user = userEvent.setup();
      server({ access: SCOPED });
      renderApp({ path: '/clusters/c1/restores/new?backup=nightly-1' });
      await screen.findByRole('heading', { name: 'Source' });
      await next(user);
      await screen.findByText(/Your access covers only some namespaces/);
      const select = screen.getByLabelText('Cluster-scoped resources');
      expect(select).toBeDisabled();
      await waitFor(() => {
        expect(select).toHaveValue('no');
      });
      await next(user);
      expect(screen.getByRole('alert')).toHaveTextContent(/name each namespace/);
      await user.type(screen.getByLabelText('Namespaces to restore'), 'dev');
      await next(user);
      expect(await screen.findByRole('heading', { name: 'Options' })).toBeVisible();
      expect(screen.getByLabelText('Advanced settings (JSON)')).toBeDisabled();
    });
  });

  it('explains instead of showing a form to someone who may not restore', async () => {
    server({ access: NONE });
    renderApp({ path: '/clusters/c1/restores/new' });
    expect(await screen.findByText('You cannot restore here')).toBeVisible();
    expect(screen.queryByLabelText('Backup')).toBeNull();
  });
});

describe('the entry points', () => {
  it('the backup page starts the wizard with that backup, or says why it cannot', async () => {
    server();
    const { unmount } = renderApp({ path: '/clusters/c1/backups/nightly-1' });
    expect(await screen.findByRole('link', { name: 'Restore from this backup' })).toHaveAttribute(
      'href',
      '/clusters/c1/restores/new?backup=nightly-1',
    );
    unmount();

    server({ access: NONE });
    const { unmount: second } = renderApp({ path: '/clusters/c1/backups/nightly-1' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Restore from this backup' })).toBeDisabled();
    });
    expect(
      screen.getByRole('button', { name: 'Restore from this backup' }).getAttribute('title'),
    ).toMatch(/restore:create/);
    second();

    server({ backup: { ...BACKUP, summary: { ...BACKUP.summary, phase: 'InProgress' } } });
    renderApp({ path: '/clusters/c1/backups/nightly-1' });
    const waiting = await screen.findByRole('button', { name: 'Restore from this backup' });
    expect(waiting).toBeDisabled();
    expect(waiting.getAttribute('title')).toMatch(/completed backup/);
  });

  it('the restores list offers Restore to whoever may', async () => {
    server();
    renderApp({ path: '/clusters/c1/restores' });
    expect(await screen.findByRole('link', { name: 'Restore' })).toHaveAttribute(
      'href',
      '/clusters/c1/restores/new',
    );
  });
});
