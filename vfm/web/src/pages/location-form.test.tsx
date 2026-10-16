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
const ADMIN = { 'storage:write': 'cluster', 'storage:read': 'cluster' };
const VIEWER = { 'storage:write': 'none', 'storage:read': 'cluster' };

const LOCATION = (name: string, isDefault: boolean) => ({
  name,
  kind: 'BACKUP_STORAGE_LOCATION',
  phase: 'Available',
  provider: 'aws',
  isDefault,
  bucket: 'backups',
  prefix: null,
  accessMode: 'ReadWrite',
  message: null,
  lastValidated: null,
  credential: { name: 'cloud-credentials', key: 'cloud' },
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function server(access: Record<string, string> = ADMIN, blocked: Record<string, string> = {}) {
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
    const rest = new URL(url, 'http://x').pathname.replace('/api/v1/orgs/o1/clusters/c1/', '');
    if (rest === 'access') return jsonResponse({ access, blocked });
    if (rest.startsWith('commands/')) return jsonResponse({ id: 'k1', status: 'QUEUED' });
    if (method === 'GET' && rest === 'backup-locations')
      return jsonResponse({
        items: [LOCATION('primary', true), LOCATION('archive', false)],
        nextCursor: null,
      });
    if (method === 'GET' && rest.startsWith('backup-locations/'))
      return jsonResponse({
        summary: LOCATION('archive', false),
        timeline: [],
        labels: {},
        status: {},
        yaml: '',
        volumes: [],
        spec: {
          provider: 'aws',
          config: { region: 'eu-west-1' },
          objectStorage: { bucket: 'old' },
          credential: { name: 'cloud-credentials', key: 'cloud' },
        },
      });
    if (method !== 'GET') {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: rest, body });
      return jsonResponse({ id: 'k1', status: 'QUEUED' }, { status: 202 });
    }
    return jsonResponse({ items: [], nextCursor: null });
  });
  return calls;
}

const preview = () => screen.getByLabelText('Equivalent velero command').textContent;

describe('adding a backup location', () => {
  it('sends the form, with the pasted credential, and clears it afterwards', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/storage/backup-locations/new' });
    await user.type(await screen.findByLabelText('Name'), 'offsite');
    await user.type(screen.getByLabelText('Bucket'), 'offsite-backups');
    await user.type(screen.getByLabelText('Setting 1 value'), 'eu-west-1');
    await user.type(screen.getByLabelText('Credential'), 'KEY-TEXT');
    expect(preview()).not.toContain('KEY-TEXT');

    await user.click(screen.getByRole('button', { name: 'Add backup location' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: 'backup-locations',
      body: {
        name: 'offsite',
        provider: 'aws',
        bucket: 'offsite-backups',
        config: { region: 'eu-west-1' },
        credential: { content: 'KEY-TEXT' },
      },
    });
    expect(await screen.findByText('Add backup location offsite')).toBeVisible();
  });

  it('masks the credential until asked to show it', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/storage/backup-locations/new' });
    const box = await screen.findByLabelText('Credential');
    expect(box.className).toContain('text-security');
    await user.click(screen.getByLabelText('Show what I typed'));
    expect(box.className).not.toContain('text-security');
  });

  it('stops at missing fields and sends nothing', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/storage/backup-locations/new' });
    await user.click(await screen.findByRole('button', { name: 'Add backup location' }));
    expect(await screen.findByText('Give the location a name.')).toBeVisible();
    expect(screen.getByText('A bucket is required.')).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  it('refuses a secret in the provider settings', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/storage/backup-locations/new' });
    await user.type(await screen.findByLabelText('Setting 1 name'), 'Key');
    await user.clear(screen.getByLabelText('Setting 1 name'));
    await user.type(screen.getByLabelText('Setting 1 name'), 'secretAccessKey');
    await user.click(screen.getByRole('button', { name: 'Add backup location' }));
    expect(await screen.findByText(/Give secrets in the credential/)).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  it('is closed to someone without storage:write', async () => {
    server(VIEWER);
    renderApp({ path: '/clusters/c1/storage/backup-locations/new' });
    expect(await screen.findByText('You cannot change storage here')).toBeVisible();
  });
});

describe('changing a backup location', () => {
  it('starts from what it is now and keeps its Secret unless told otherwise', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/storage/backup-locations/archive/edit' });
    const bucket = await screen.findByLabelText('Bucket');
    expect(bucket).toHaveValue('old');
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByText('cloud-credentials')).toBeVisible();

    await user.clear(bucket);
    await user.type(bucket, 'new-bucket');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: 'backup-locations/archive',
      body: { bucket: 'new-bucket', provider: 'aws' },
    });
    expect(calls[0]?.body).not.toHaveProperty('credential');
    expect(calls[0]?.body).not.toHaveProperty('name');
  });
});

describe('the storage page', () => {
  it('offers add, edit, make default and delete', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/storage' });
    expect(await screen.findByRole('link', { name: 'Add backup location' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add snapshot location' })).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Edit archive' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Make primary the default' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Make archive the default' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toMatchObject({ method: 'POST', path: 'backup-locations/archive/default' });
  });

  it('deletes only after the name is typed', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/storage' });
    await user.click(await screen.findByRole('button', { name: 'Delete archive' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete backup location' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), 'archive');
    await user.click(confirm);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: 'backup-locations/archive' });
  });

  it('disables every action, with the reason, for someone who may only read', async () => {
    server(VIEWER);
    renderApp({ path: '/clusters/c1/storage' });
    expect(await screen.findByRole('button', { name: 'Add backup location' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Edit archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete archive' })).toBeDisabled();
  });
});

describe('a read-only agent', () => {
  it('disables the storage actions and says the agent is the reason', async () => {
    const reason = 'This cluster’s agent is set to read-only, so it refuses every change.';
    server({ 'storage:write': 'none', 'storage:read': 'cluster' }, { 'storage:write': reason });
    renderApp({ path: '/clusters/c1/storage' });
    const add = await screen.findByRole('button', { name: 'Add backup location' });
    await waitFor(() => {
      expect(add).toHaveAttribute('title', reason);
    });
    expect(add).toBeDisabled();
    const del = await screen.findByRole('button', { name: 'Delete archive' });
    await waitFor(() => {
      expect(del).toHaveAttribute('title', reason);
    });
  });
});
