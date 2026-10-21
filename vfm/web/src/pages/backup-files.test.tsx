import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { LogView } from '@/components/file-panel';
import { jsonResponse, renderApp, stubFetch } from '@/test/utils';
import { render } from '@testing-library/react';

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
const DETAIL = {
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
  yaml: 'kind: Backup\n',
  volumes: [],
};

const RESTORE_DETAIL = {
  ...DETAIL,
  summary: {
    name: 'r1',
    phase: 'Completed',
    startedAt: null,
    completedAt: null,
    createdByVfm: false,
    backupName: 'nightly-1',
    scheduleName: null,
    scope: { all: true, namespaces: [], more: 0 },
    existingResourcePolicy: null,
    warnings: 0,
    errors: 0,
    itemsRestored: null,
    totalItems: null,
    failureReason: null,
  },
};

const text = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Vfm-Fetched-At': '2026-10-16T01:00:00.000Z',
      'X-Vfm-Expires-At': '2026-10-23T01:00:00.000Z',
    },
  });
const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ title: 'Problem', status, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

interface Call {
  method: string;
  path: string;
}

/** A server whose files are answered by `file(path, method)`, and which records each call. */
function server(
  file: (path: string, method: string, calls: Call[]) => Response,
  command?: () => unknown,
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
    if (rest.startsWith('commands/')) return jsonResponse(command?.() ?? {});
    if (/^backups\/[^/]+$/.test(rest)) return jsonResponse(DETAIL);
    if (/^restores\/[^/]+$/.test(rest)) return jsonResponse(RESTORE_DETAIL);
    if (/^(backups|restores)\//.test(rest)) {
      const path = rest + u.search;
      calls.push({ method, path });
      return file(path, method, calls);
    }
    return jsonResponse({});
  });
  return calls;
}

/** The card whose title is `title`. */
async function cardOf(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title });
  const card = heading.closest('div')?.parentElement;
  if (card === null || card === undefined) {
    throw new Error(`no card around ${title}`);
  }
  return card;
}

const nothingSaved = () => new Response(null, { status: 204 });

describe('the files of a backup', () => {
  it('asks for nothing until someone clicks, then follows the fetch to the log', async () => {
    const user = userEvent.setup();
    let fetched = false;
    const calls = server(
      (path, method) => {
        if (path.startsWith('backups/nightly-1/logs')) {
          if (method === 'POST')
            return jsonResponse(
              { state: 'fetching', command: { id: 'k1', status: 'QUEUED' } },
              { status: 202 },
            );
          return fetched
            ? text('time="t" level=info msg="Backed up item 1"\ntime="t" level=error msg="boom"\n')
            : nothingSaved();
        }
        return nothingSaved();
      },
      () => {
        fetched = true;
        return { id: 'k1', status: 'SUCCEEDED', errorMessage: null };
      },
    );
    renderApp({ path: '/clusters/c1/backups/nightly-1' });

    const logCard = await cardOf('Log');
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Fetch from the cluster' })).toHaveLength(5);
    });
    // Only reads, never a POST, before the click.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);

    await user.click(within(logCard).getByRole('button', { name: 'Fetch from the cluster' }));

    expect(await screen.findByLabelText('Log', undefined, { timeout: 5000 })).toHaveTextContent(
      'Backed up item 1',
    );
    expect(screen.getByText('1 errors')).toBeVisible();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('backups/nightly-1/logs');
    // The download link goes straight to the server with the attachment flag.
    expect(screen.getAllByRole('link', { name: 'Download' })[0]).toHaveAttribute(
      'href',
      '/api/v1/orgs/o1/clusters/c1/backups/nightly-1/logs?download=1',
    );
  }, 15_000);

  it('shows a copy the server already holds without asking the agent', async () => {
    const calls = server((path) =>
      path.startsWith('backups/nightly-1/logs') ? text('hello log\n') : nothingSaved(),
    );
    renderApp({ path: '/clusters/c1/backups/nightly-1' });
    expect(await screen.findByLabelText('Log')).toHaveTextContent('hello log');
    expect(screen.getAllByText(/Fetched/).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('says why a fetch failed and offers to try again', async () => {
    const user = userEvent.setup();
    const calls = server(
      (path, method) => {
        if (path.startsWith('backups/nightly-1/logs') && method === 'POST') {
          return jsonResponse(
            { state: 'fetching', command: { id: 'k2', status: 'QUEUED' } },
            { status: 202 },
          );
        }
        return nothingSaved();
      },
      () => ({ id: 'k2', status: 'FAILED', errorMessage: 'the file is not in the object storage' }),
    );
    renderApp({ path: '/clusters/c1/backups/nightly-1' });
    const card = await cardOf('Log');
    await user.click(await within(card).findByRole('button', { name: 'Fetch from the cluster' }));

    expect(
      await within(card).findByText('the file is not in the object storage', undefined, {
        timeout: 5000,
      }),
    ).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(
        calls.filter((c) => c.method === 'POST' && c.path.includes('refresh=true')),
      ).toHaveLength(1);
    });
  }, 15_000);

  it('keeps one panel’s refusal from spoiling the others', async () => {
    server((path) =>
      path.startsWith('backups/nightly-1/logs')
        ? problem(403, 'missing permission backup:logs')
        : text('{"v1/Pod":["shop/a","shop/b"],"apps/v1/Deployment":["shop/web"]}'),
    );
    renderApp({ path: '/clusters/c1/backups/nightly-1' });

    expect(await screen.findByText(/You do not have permission to read this/)).toBeVisible();
    expect(screen.getByText(/missing permission backup:logs/)).toBeVisible();
    // The resource list, a detail part, still renders, grouped by kind.
    expect(await screen.findByText('3 items in 2 kinds')).toBeVisible();
    expect(screen.getByText('apps/v1/Deployment')).toBeVisible();
  });

  it('says plainly when Velero recorded nothing', async () => {
    server((path) => (path.includes('results') ? text('{}') : nothingSaved()));
    renderApp({ path: '/clusters/c1/backups/nightly-1' });
    expect(await screen.findByText('Velero recorded nothing here.')).toBeVisible();
  });

  it('lets a restore read its own files', async () => {
    const calls = server((path) =>
      path.startsWith('restores/r1/logs') ? text('restore log\n') : nothingSaved(),
    );
    renderApp({ path: '/clusters/c1/restores/r1' });
    expect(await screen.findByLabelText('Log')).toHaveTextContent('restore log');
    expect(calls.some((c) => c.path.startsWith('restores/r1/details/volume-info'))).toBe(true);
  });
});

describe('the log view', () => {
  const LOG = [
    'time="t" level=info msg="one"',
    'time="t" level=warning msg="two"',
    'time="t" level=error msg="three"',
    'time="t" level=debug msg="four"',
    'a line with no level',
  ].join('\n');

  it('counts problems and filters by level and by text', async () => {
    const user = userEvent.setup();
    render(<LogView text={LOG} />);
    expect(screen.getByText('1 errors')).toBeVisible();
    expect(screen.getByText('1 warnings')).toBeVisible();
    expect(screen.getByText('5 lines')).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Level'), 'error');
    const log = screen.getByLabelText('Log');
    expect(log).toHaveTextContent('three');
    expect(log).not.toHaveTextContent('one');

    await user.selectOptions(screen.getByLabelText('Level'), 'all');
    await user.type(screen.getByLabelText('Search the log'), 'NO LEVEL');
    expect(screen.getByLabelText('Log')).toHaveTextContent('a line with no level');
    expect(screen.getByLabelText('Log')).not.toHaveTextContent('three');

    await user.clear(screen.getByLabelText('Search the log'));
    await user.type(screen.getByLabelText('Search the log'), 'zzz');
    expect(screen.getByText('No line matches these filters.')).toBeVisible();
  });

  it('shows a long log a page at a time', async () => {
    const user = userEvent.setup();
    const long = Array.from(
      { length: 1200 },
      (_, i) => `level=info msg="line ${i.toString()}"`,
    ).join('\n');
    render(<LogView text={long} />);
    expect(screen.getByText('Showing 500 of 1200 lines')).toBeVisible();
    expect(screen.getByLabelText('Log')).not.toHaveTextContent('line 700');

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText('Showing 1000 of 1200 lines')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByLabelText('Log')).toHaveTextContent('line 1199');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('says an empty log is empty', () => {
    render(<LogView text="" />);
    expect(screen.getByText('The log is empty.')).toBeVisible();
  });

  it('shows markup in a log as text, never as markup', () => {
    render(<LogView text={'level=error msg="<img src=x onerror=alert(1)>"'} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByLabelText('Log')).toHaveTextContent('<img src=x onerror=alert(1)>');
  });
});
