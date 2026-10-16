import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { BackupRow, Detail } from '@/lib/resources';
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

const backup = (name: string, over: Partial<BackupRow> = {}): BackupRow => ({
  name,
  phase: 'Completed',
  startedAt: '2026-10-16T01:00:00Z',
  completedAt: '2026-10-16T01:03:05Z',
  expiresAt: '2026-11-15T01:00:00Z',
  createdByVfm: false,
  schedule: null,
  storageLocation: 'default',
  ttl: '720h0m0s',
  scope: { all: false, namespaces: ['shop'], more: 0 },
  includesClusterResources: false,
  warnings: 0,
  errors: 0,
  itemsBackedUp: 9,
  totalItems: 10,
  volumeSnapshots: { attempted: null, completed: null },
  failureReason: null,
  ...over,
});

interface Server {
  urls: string[];
}

function server(
  handler: (path: string, params: URLSearchParams) => unknown,
  role = 'OWNER',
): Server {
  const seen: Server = { urls: [] };
  stubFetch((url) => {
    if (url.endsWith('/auth/me')) {
      return jsonResponse({ user: USER });
    }
    if (url.endsWith('/me/orgs')) {
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: role, active: true }],
      });
    }
    if (url.endsWith('/overview')) {
      return jsonResponse({
        cluster: CLUSTER,
        inventory: { snapshotId: 's', syncedAt: null, kinds: {} },
        locations: null,
        recentBackups: null,
        recentRestores: null,
      });
    }
    const u = new URL(url, 'http://x');
    const rest = u.pathname.replace('/api/v1/orgs/o1/clusters/c1/', '');
    if (rest !== u.pathname) {
      seen.urls.push(rest + u.search);
      const out = handler(rest, u.searchParams);
      if (out instanceof Response) {
        return out;
      }
      return jsonResponse(out);
    }
    return jsonResponse({ status: 'ok' });
  });
  return seen;
}

describe('backups list', () => {
  it('shows what a table needs and links each backup to its page', async () => {
    server(() => ({
      items: [
        backup('nightly-1', { schedule: 'nightly', createdByVfm: true, warnings: 2, errors: 1 }),
        backup('adhoc', {
          phase: 'PartiallyFailed',
          scope: { all: true, namespaces: [], more: 0 },
          itemsBackedUp: null,
        }),
      ],
      nextCursor: null,
    }));
    renderApp({ path: '/clusters/c1/backups' });

    const link = await screen.findByRole('link', { name: 'nightly-1' });
    expect(link).toHaveAttribute('href', '/clusters/c1/backups/nightly-1');
    expect(screen.getByText('via VFM')).toBeVisible();
    expect(screen.getByText('1 errors')).toBeVisible();
    expect(screen.getByText('2 warnings')).toBeVisible();
    expect(screen.getByText('all namespaces')).toBeVisible();
    expect(screen.getByText('PartiallyFailed')).toBeVisible();
    expect(screen.getAllByText('3 min 5 s')).toHaveLength(2);
    expect(screen.getByText('9 / 10')).toBeVisible();
    // The Backups tab is where we are.
    const tabs = screen.getByRole('navigation', { name: 'Cluster sections' });
    expect(within(tabs).getByText('Backups')).toHaveAttribute('aria-current', 'page');
  });

  it('sends the filters it shows, and starts again from the first page when one changes', async () => {
    const user = userEvent.setup();
    const seen = server((_p, params) => ({
      items:
        params.get('phase') === 'Failed,FailedValidation'
          ? [backup('broken', { phase: 'Failed' })]
          : [backup('fine')],
      nextCursor: null,
    }));
    renderApp({ path: '/clusters/c1/backups' });
    await screen.findByText('fine');

    await user.selectOptions(screen.getByLabelText('Phase'), 'Failed');
    expect(await screen.findByText('broken')).toBeVisible();
    expect(
      seen.urls.some(
        (u) => u.includes('phase=Failed%2CFailedValidation') && !u.includes('cursor='),
      ),
    ).toBe(true);

    await user.selectOptions(screen.getByLabelText('Sort by'), 'name');
    await user.click(screen.getByRole('button', { name: /switch to ascending/ }));
    await waitFor(() => {
      expect(seen.urls.some((u) => u.includes('sort=name') && u.includes('order=asc'))).toBe(true);
    });
  });

  it('waits for the typing to stop before searching', async () => {
    const user = userEvent.setup();
    const seen = server(() => ({ items: [backup('a')], nextCursor: null }));
    renderApp({ path: '/clusters/c1/backups' });
    await screen.findByText('a');
    const before = seen.urls.length;

    await user.type(screen.getByLabelText('Name'), 'nightly');
    await waitFor(() => {
      expect(seen.urls.some((u) => u.includes('q=nightly'))).toBe(true);
    });
    // One request for the finished word, not one per letter.
    const queries = seen.urls.slice(before).filter((u) => u.includes('q='));
    expect(queries.length).toBeLessThanOrEqual(2);
    expect(queries.some((u) => u.includes('q=n&') || u.endsWith('q=n'))).toBe(false);
  });

  it('loads the next page with the cursor the server gave, and stops when there is none', async () => {
    const user = userEvent.setup();
    const seen = server((_p, params) =>
      params.get('cursor') === 'abc'
        ? { items: [backup('second')], nextCursor: null }
        : { items: [backup('first')], nextCursor: 'abc' },
    );
    renderApp({ path: '/clusters/c1/backups' });
    await screen.findByText('first');

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('second')).toBeVisible();
    expect(screen.getByText('first')).toBeVisible();
    expect(seen.urls.some((u) => u.includes('cursor=abc'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('tells "nothing yet" apart from "nothing matches"', async () => {
    const user = userEvent.setup();
    server((_p, params) => ({ items: [], nextCursor: null, q: params.get('q') }));
    renderApp({ path: '/clusters/c1/backups' });

    expect(await screen.findByText(/No backups have been reported yet/)).toBeVisible();
    await user.type(screen.getByLabelText('Name'), 'zzz');
    expect(await screen.findByText('No backups match these filters.')).toBeVisible();
  });

  it('says what went wrong when the list cannot be read', async () => {
    server(
      () =>
        new Response(
          JSON.stringify({
            title: 'Forbidden',
            status: 403,
            detail: 'missing permission backup:read',
          }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        ),
    );
    renderApp({ path: '/clusters/c1/backups' });
    expect(await screen.findByText(/missing permission backup:read/)).toBeVisible();
  });
});

describe('other lists', () => {
  it('lists restores with a link to the source backup', async () => {
    server(() => ({
      items: [
        {
          name: 'r1',
          phase: 'Completed',
          startedAt: '2026-10-16T02:00:00Z',
          completedAt: '2026-10-16T02:01:00Z',
          createdByVfm: false,
          backupName: 'nightly-1',
          scheduleName: null,
          scope: { all: false, namespaces: ['shop'], more: 0 },
          existingResourcePolicy: null,
          warnings: 0,
          errors: 0,
          itemsRestored: null,
          totalItems: null,
          failureReason: null,
        },
      ],
      nextCursor: null,
    }));
    renderApp({ path: '/clusters/c1/restores' });
    expect(await screen.findByRole('link', { name: 'nightly-1' })).toHaveAttribute(
      'href',
      '/clusters/c1/backups/nightly-1',
    );
  });

  it('shows a paused schedule as paused, with its cron and any validation error', async () => {
    server(() => ({
      items: [
        {
          name: 'weekly',
          phase: 'Enabled',
          createdByVfm: false,
          cron: '0 2 * * 0',
          paused: true,
          lastBackup: null,
          storageLocation: null,
          ttl: null,
          scope: { all: true, namespaces: [], more: 0 },
          validationErrors: [],
        },
        {
          name: 'broken',
          phase: 'FailedValidation',
          createdByVfm: false,
          cron: 'nonsense',
          paused: false,
          lastBackup: null,
          storageLocation: null,
          ttl: null,
          scope: { all: true, namespaces: [], more: 0 },
          validationErrors: ['invalid cron'],
        },
      ],
      nextCursor: null,
    }));
    renderApp({ path: '/clusters/c1/schedules' });
    expect(await screen.findByText('paused')).toBeVisible();
    expect(screen.getByText('0 2 * * 0')).toBeVisible();
    expect(screen.getByText('invalid cron')).toBeVisible();
  });

  it('shows storage as three sections, with only a reference to a credential', async () => {
    server((path) => {
      if (path.startsWith('backup-locations')) {
        return {
          items: [
            {
              name: 'default',
              kind: 'BACKUP_STORAGE_LOCATION',
              phase: 'Unavailable',
              provider: 'aws',
              isDefault: true,
              bucket: 'b',
              prefix: 'p',
              accessMode: 'ReadWrite',
              message: 'permission denied',
              lastValidated: null,
              credential: { name: 'cloud-credentials', key: 'cloud' },
            },
          ],
          nextCursor: null,
        };
      }
      return { items: [], nextCursor: null };
    });
    renderApp({ path: '/clusters/c1/storage' });

    expect(await screen.findByText('permission denied')).toBeVisible();
    expect(screen.getByText('b/p')).toBeVisible();
    expect(screen.getByText('cloud-credentials / cloud')).toBeVisible();
    expect(screen.getAllByText('default').length).toBeGreaterThan(0);
    expect(await screen.findByText(/No backup repositories|None\. Repositories/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Volume snapshot locations' })).toBeVisible();
  });
});

describe('detail pages', () => {
  const detail: Detail<BackupRow> = {
    summary: backup('nightly-1', {
      schedule: 'nightly',
      warnings: 1,
      volumeSnapshots: { attempted: 3, completed: 2 },
    }),
    timeline: [
      { at: '2026-10-16T00:59:59Z', event: 'Created' },
      { at: '2026-10-16T01:03:05Z', event: 'Finished: Completed' },
    ],
    labels: {},
    spec: {},
    status: {},
    yaml: 'kind: Backup\nmetadata:\n  name: nightly-1\n',
    volumes: [
      {
        kind: 'POD_VOLUME_BACKUP',
        name: 'pvb-1',
        phase: 'Completed',
        uploader: 'kopia',
        bytesDone: 50,
        totalBytes: 100,
      },
    ],
  };

  it('shows the summary, timeline, volumes and YAML of a backup', async () => {
    server((path) =>
      path.startsWith('backups/nightly-1') ? detail : { items: [], nextCursor: null },
    );
    renderApp({ path: '/clusters/c1/backups/nightly-1' });

    expect(await screen.findByRole('heading', { level: 1, name: 'nightly-1' })).toBeVisible();
    expect(await screen.findByText('2 of 3 completed')).toBeVisible();
    expect(screen.getByText('9 of 10 backed up')).toBeVisible();
    const timeline = screen.getByRole('list', { name: 'Timeline' });
    expect(within(timeline).getByText('Finished: Completed')).toBeVisible();
    expect(screen.getByText('50%')).toBeVisible();
    expect(screen.getByLabelText('YAML').textContent).toContain('kind: Backup');
    expect(screen.getByRole('link', { name: 'Back to backups' })).toHaveAttribute(
      'href',
      '/clusters/c1/backups',
    );
  });

  it('keeps "restore from this backup" visible but disabled, with the reason', async () => {
    server(() => detail);
    renderApp({ path: '/clusters/c1/backups/nightly-1' });
    const button = await screen.findByRole('button', { name: 'Restore from this backup' });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/M4/);
  });

  it('answers "not found" the same way for a backup that is gone and one the caller may not see', async () => {
    server(
      () =>
        new Response(
          JSON.stringify({ title: 'Not Found', status: 404, detail: 'backup not found' }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        ),
    );
    renderApp({ path: '/clusters/c1/backups/whatever' });
    expect(await screen.findByText('This backup was not found')).toBeVisible();
    expect(screen.getByText(/may not be one you have access to/)).toBeVisible();
    // A page-level notice, not a raw error.
    expect(screen.queryByText(/backup not found/)).toBeNull();
  });

  it('links a restore to its source backup', async () => {
    server(() => ({
      ...detail,
      summary: {
        name: 'r1',
        phase: 'Completed',
        startedAt: null,
        completedAt: null,
        createdByVfm: false,
        backupName: 'nightly-1',
        scheduleName: null,
        scope: { all: true, namespaces: [], more: 0 },
        existingResourcePolicy: 'update',
        warnings: 0,
        errors: 0,
        itemsRestored: 4,
        totalItems: 4,
        failureReason: null,
      },
      yaml: 'kind: Restore\n',
    }));
    renderApp({ path: '/clusters/c1/restores/r1' });
    expect(await screen.findByRole('link', { name: 'nightly-1' })).toHaveAttribute(
      'href',
      '/clusters/c1/backups/nightly-1',
    );
    expect(screen.getByText('update')).toBeVisible();
    expect(screen.getByText('4 of 4 restored')).toBeVisible();
  });
});
