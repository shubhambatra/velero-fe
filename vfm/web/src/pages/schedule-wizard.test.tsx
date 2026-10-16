import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { CronBuilder } from '@/components/cron-builder';
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
  'schedule:write': 'cluster',
  'schedule:delete': 'cluster',
  'advanced:write': 'cluster',
};
const SCOPED: Record<string, string> = {
  'backup:create': 'scoped',
  'schedule:write': 'scoped',
  'schedule:delete': 'none',
  'advanced:write': 'none',
};
const NONE: Record<string, string> = {
  'backup:create': 'none',
  'schedule:write': 'none',
  'schedule:delete': 'none',
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const STORED = {
  schedule: '30 1 * * 0',
  paused: false,
  template: {
    includedNamespaces: ['shop', 'cart'],
    includeClusterResources: false,
    ttl: '720h0m0s',
    metadata: { labels: { team: 'shop' } },
    hooks: { resources: [{ name: 'freeze' }] },
  },
};

const ROW = {
  name: 'nightly',
  phase: 'Enabled',
  createdByVfm: false,
  cron: '30 1 * * 0',
  paused: false,
  lastBackup: null,
  storageLocation: null,
  ttl: null,
  scope: { all: true, namespaces: [], more: 0 },
  validationErrors: [],
};

function server(
  options: {
    access?: Record<string, string>;
    post?: (path: string, body: unknown) => Response;
    schedules?: unknown[];
    stored?: unknown;
    missing?: boolean;
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
      return jsonResponse({ items: [{ name: 'default', isDefault: true }], nextCursor: null });
    if (rest.startsWith('snapshot-locations')) return jsonResponse({ items: [], nextCursor: null });
    if (rest.startsWith('commands/')) return jsonResponse({ id: 'k1', status: 'QUEUED' });
    if (rest === 'schedules' && method === 'GET')
      return jsonResponse({ items: options.schedules ?? [], nextCursor: null });
    if (rest.startsWith('schedules/') && method === 'GET') {
      if (options.missing === true) {
        return new Response(
          JSON.stringify({ title: 'Not Found', status: 404, detail: 'schedule not found' }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        );
      }
      return jsonResponse({
        summary: ROW,
        timeline: [],
        labels: {},
        spec: options.stored ?? STORED,
        status: {},
        yaml: '',
        volumes: [],
      });
    }
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

const next = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Next' }));
};
const preview = () => screen.getByLabelText('Equivalent velero command').textContent;

describe('the schedule wizard: creating', () => {
  it('walks through the steps and sends the schedule', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/schedules/new' });

    expect(await screen.findByRole('heading', { name: 'When' })).toBeVisible();
    await user.type(screen.getByLabelText('Name'), 'weekly-shop');
    await user.selectOptions(screen.getByLabelText('Repeat'), 'Every week');
    await user.selectOptions(screen.getByLabelText('On'), 'Friday');
    await user.selectOptions(screen.getByLabelText('Hour (UTC)'), '03');
    expect(screen.getByLabelText('Cron expression')).toHaveValue('0 3 * * 5');
    await next(user);

    expect(await screen.findByRole('heading', { name: 'What to back up' })).toBeVisible();
    expect(screen.queryByLabelText('Name')).toBeNull();
    await user.type(screen.getByLabelText('Namespaces to include'), 'shop');
    await user.selectOptions(screen.getByLabelText('Cluster-scoped resources'), 'No');
    await next(user);

    expect(await screen.findByRole('heading', { name: 'Storage and volumes' })).toBeVisible();
    await next(user);

    expect(await screen.findByRole('heading', { name: 'Options' })).toBeVisible();
    await user.type(screen.getByLabelText('Keep for'), '720h');
    await user.selectOptions(screen.getByLabelText('Start paused'), 'Yes');
    await next(user);

    expect(await screen.findByRole('heading', { name: 'Review' })).toBeVisible();
    expect(JSON.parse(screen.getByLabelText('Request').textContent)).toEqual({
      name: 'weekly-shop',
      schedule: '0 3 * * 5',
      paused: true,
      template: { includedNamespaces: ['shop'], includeClusterResources: false, ttl: '720h' },
    });

    await user.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: 'schedules',
      body: { name: 'weekly-shop', schedule: '0 3 * * 5', paused: true },
    });
    expect(await screen.findByText('Create schedule weekly-shop')).toBeVisible();
  });

  it('keeps the equivalent command current', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/schedules/new' });
    await screen.findByRole('heading', { name: 'When' });
    expect(preview()).toBe("velero schedule create <name> --schedule '0 2 * * *'");
    await user.type(screen.getByLabelText('Name'), 'nightly');
    await user.selectOptions(screen.getByLabelText('Repeat'), 'Every hour');
    expect(preview()).toBe("velero schedule create nightly --schedule '0 * * * *'");
  });

  it('stops at an unreadable cron expression and says so', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/schedules/new' });
    await screen.findByRole('heading', { name: 'When' });
    await user.type(screen.getByLabelText('Name'), 'nightly');
    await user.clear(screen.getByLabelText('Cron expression'));
    await user.type(screen.getByLabelText('Cron expression'), 'every day');
    await next(user);
    expect(screen.getByRole('heading', { name: 'When' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/five fields/);
    expect(screen.getByLabelText('Cron expression')).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
  });

  it('needs a name', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/clusters/c1/schedules/new' });
    await screen.findByRole('heading', { name: 'When' });
    await next(user);
    expect(screen.getByRole('heading', { name: 'When' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/needs a name/);
  });

  it('shows the server’s refusal and keeps the form', async () => {
    const user = userEvent.setup();
    server({ post: () => problem(403, 'missing permission schedule:write') });
    renderApp({ path: '/clusters/c1/schedules/new' });
    await screen.findByRole('heading', { name: 'When' });
    await user.type(screen.getByLabelText('Name'), 'keep-me');
    for (let i = 0; i < 4; i += 1) await next(user);
    await user.click(await screen.findByRole('button', { name: 'Create schedule' }));
    expect(await screen.findByText(/missing permission schedule:write/)).toBeVisible();
    expect(screen.getByLabelText('Request')).toHaveTextContent('keep-me');
  });

  it('holds a namespace-limited user to naming namespaces and leaving cluster resources out', async () => {
    const user = userEvent.setup();
    server({ access: SCOPED });
    renderApp({ path: '/clusters/c1/schedules/new' });
    await screen.findByRole('heading', { name: 'When' });
    await user.type(screen.getByLabelText('Name'), 'mine');
    await next(user);
    await screen.findByRole('heading', { name: 'What to back up' });
    expect(screen.getByLabelText('Cluster-scoped resources')).toBeDisabled();
    await next(user);
    expect(screen.getByRole('heading', { name: 'What to back up' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/name each namespace/);
    await user.type(screen.getByLabelText('Namespaces to include'), 'dev');
    await next(user);
    expect(await screen.findByRole('heading', { name: 'Storage and volumes' })).toBeVisible();
  });

  it('tells someone without access why they cannot create one', async () => {
    server({ access: NONE });
    renderApp({ path: '/clusters/c1/schedules/new' });
    expect(await screen.findByText('You cannot create schedules here')).toBeVisible();
    expect(screen.getByText(/schedule:write/)).toBeVisible();
  });
});

describe('the schedule wizard: editing', () => {
  it('starts from the stored schedule and sends the whole spec back, keeping what the form cannot show', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1/schedules/nightly/edit' });

    expect(await screen.findByRole('heading', { name: 'When' })).toBeVisible();
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByLabelText('Cron expression')).toHaveValue('30 1 * * 0');
    // The pickers follow the expression.
    expect(screen.getByLabelText('Repeat')).toHaveValue('weekly');
    await user.selectOptions(screen.getByLabelText('On'), 'Monday');
    await next(user);

    expect(await screen.findByLabelText('Namespaces to include')).toHaveValue('shop,cart');
    await next(user);
    await next(user);
    expect(await screen.findByLabelText('Keep for')).toHaveValue('720h0m0s');
    expect(screen.getByText(/has backup hooks/)).toBeVisible();
    await next(user);

    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({
      method: 'PUT',
      path: 'schedules/nightly',
      body: {
        schedule: '30 1 * * 1',
        template: {
          includedNamespaces: ['shop', 'cart'],
          includeClusterResources: false,
          ttl: '720h0m0s',
          metadataLabels: { team: 'shop' },
        },
      },
    });
    expect(await screen.findByText('Update schedule nightly')).toBeVisible();
  });

  it('says so when the schedule cannot be loaded', async () => {
    server({ missing: true });
    renderApp({ path: '/clusters/c1/schedules/ghost/edit' });
    expect(await screen.findByText('This schedule could not be loaded')).toBeVisible();
    expect(screen.getByText(/schedule not found/)).toBeVisible();
  });
});

describe('the schedules list', () => {
  it('offers a way to create one', async () => {
    server({ schedules: [ROW] });
    renderApp({ path: '/clusters/c1/schedules' });
    const link = await screen.findByRole('link', { name: 'New schedule' });
    expect(link).toHaveAttribute('href', '/clusters/c1/schedules/new');
  });

  it('links to edit', async () => {
    server({ schedules: [ROW] });
    renderApp({ path: '/clusters/c1/schedules' });
    expect(await screen.findByRole('link', { name: 'Edit nightly' })).toHaveAttribute(
      'href',
      '/clusters/c1/schedules/nightly/edit',
    );
  });

  it('pauses a running schedule and resumes a paused one', async () => {
    const user = userEvent.setup();
    const calls = server({ schedules: [ROW, { ...ROW, name: 'old', paused: true }] });
    renderApp({ path: '/clusters/c1/schedules' });
    await user.click(await screen.findByRole('button', { name: 'Pause nightly' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({
      method: 'POST',
      path: 'schedules/nightly/pause',
      body: { paused: true },
    });
    expect(await screen.findByText('Pause schedule nightly')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Resume old' }));
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]).toEqual({
      method: 'POST',
      path: 'schedules/old/pause',
      body: { paused: false },
    });
  });

  it('deletes only after the name is typed', async () => {
    const user = userEvent.setup();
    const calls = server({ schedules: [ROW] });
    renderApp({ path: '/clusters/c1/schedules' });
    await user.click(await screen.findByRole('button', { name: 'Delete nightly' }));
    const confirm = await screen.findByRole('button', { name: 'Delete schedule' });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/backups it has already made stay/)).toBeVisible();
    await user.type(screen.getByLabelText('Type nightly to confirm'), 'nightly');
    await user.click(confirm);
    await waitFor(() => {
      expect(calls).toEqual([{ method: 'DELETE', path: 'schedules/nightly', body: undefined }]);
    });
    expect(await screen.findByText('Delete schedule nightly')).toBeVisible();
  });

  it('disables each action with a reason for someone who may not', async () => {
    server({ schedules: [ROW], access: NONE });
    renderApp({ path: '/clusters/c1/schedules' });
    for (const label of ['Pause nightly', 'Delete nightly', 'Run nightly now', 'Edit nightly']) {
      const control = await screen.findByRole('button', { name: label });
      await waitFor(() => {
        expect(control).toBeDisabled();
      });
    }
    expect(screen.getByRole('button', { name: 'New schedule' })).toBeDisabled();
  });

  it('shows the server’s refusal to pause', async () => {
    const user = userEvent.setup();
    server({ schedules: [ROW], post: () => problem(403, 'missing permission schedule:write') });
    renderApp({ path: '/clusters/c1/schedules' });
    await user.click(await screen.findByRole('button', { name: 'Pause nightly' }));
    expect(await screen.findByText(/missing permission schedule:write/)).toBeVisible();
  });
});

describe('the cron builder', () => {
  const NOW = new Date('2026-10-16T10:00:00Z');
  function Harness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return <CronBuilder value={value} onChange={setValue} now={NOW} />;
  }

  it('lists the next five runs in UTC', () => {
    render(<Harness initial="30 2 * * *" />);
    const runs = screen.getByLabelText('Next runs').querySelectorAll('li');
    expect(runs).toHaveLength(5);
    expect(runs[0]).toHaveTextContent('2026-10-17 02:30 UTC');
    expect(runs[4]).toHaveTextContent('2026-10-21 02:30 UTC');
  });

  it('writes the expression from the pickers and reads the pickers from the expression', async () => {
    const user = userEvent.setup();
    render(<Harness initial="0 2 * * *" />);
    await user.selectOptions(screen.getByLabelText('Repeat'), 'Every month');
    await user.selectOptions(screen.getByLabelText('On day'), '15');
    expect(screen.getByLabelText('Cron expression')).toHaveValue('0 2 15 * *');

    await user.clear(screen.getByLabelText('Cron expression'));
    await user.type(screen.getByLabelText('Cron expression'), '*/5 * * * *');
    expect(screen.getByLabelText('Repeat')).toHaveValue('custom');
    expect(screen.queryByLabelText('Hour (UTC)')).toBeNull();

    await user.clear(screen.getByLabelText('Cron expression'));
    await user.type(screen.getByLabelText('Cron expression'), '15 4 * * *');
    expect(screen.getByLabelText('Repeat')).toHaveValue('daily');
    expect(screen.getByLabelText('Hour (UTC)')).toHaveValue('4');
    expect(screen.getByLabelText('Minute')).toHaveValue('15');
  });

  it('says so instead of listing runs for an expression that cannot run', async () => {
    const user = userEvent.setup();
    render(<Harness initial="0 0 31 2 *" />);
    expect(screen.getByLabelText('Next runs')).toHaveTextContent(/never matches a real date/);
    await user.clear(screen.getByLabelText('Cron expression'));
    await user.type(screen.getByLabelText('Cron expression'), 'nonsense');
    expect(screen.getByLabelText('Next runs')).toHaveTextContent(/Fix the expression/);
  });
});
