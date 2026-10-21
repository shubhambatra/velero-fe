import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: true };
const SECRET_LINK =
  'https://store.example/backups/nightly/nightly.tar.gz?X-Amz-Signature=VERY-SECRET-SIGNATURE';

const detail = (phase: string) => ({
  summary: {
    name: 'nightly',
    phase,
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
});

function server(options: { download?: 'cluster' | 'none'; phase?: string; fail?: boolean } = {}) {
  const posts: string[] = [];
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
    if (url.endsWith('/clusters/c1/access')) {
      return jsonResponse({
        access: {
          'backup:download': options.download ?? 'cluster',
          'backup:delete': 'cluster',
          'restore:create': 'cluster',
        },
      });
    }
    if (url.endsWith('/backups/nightly/download-url') && init?.method === 'POST') {
      posts.push(url);
      if (options.fail) {
        return jsonResponse(
          {
            title: 'Bad Gateway',
            status: 502,
            detail: 'the agent could not obtain a download link',
          },
          { status: 502 },
        );
      }
      return jsonResponse({
        url: SECRET_LINK,
        expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
      });
    }
    if (url.endsWith('/clusters/c1/backups/nightly'))
      return jsonResponse(detail(options.phase ?? 'Completed'));
    return jsonResponse({ status: 'ok' });
  });
  return posts;
}

describe('downloading a backup’s contents', () => {
  it('gets a link on request, offers it as a link, and keeps it out of the page text and storage', async () => {
    const user = userEvent.setup();
    const posts = server();
    renderApp({ path: '/clusters/c1/backups/nightly' });

    await user.click(await screen.findByRole('button', { name: 'Download contents' }));

    const link = await screen.findByRole('link', { name: /Download backup contents/ });
    expect(link).toHaveAttribute('href', SECRET_LINK);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(posts).toHaveLength(1);
    // The credential is a link target, not text on the page, and is in no browser storage.
    expect(document.body.textContent).not.toContain('VERY-SECRET-SIGNATURE');
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        expect(store.getItem(store.key(i) ?? '') ?? '').not.toContain('VERY-SECRET-SIGNATURE');
      }
    }

    await user.click(screen.getByRole('button', { name: 'Discard the link' }));
    expect(screen.queryByRole('link', { name: /Download backup contents/ })).toBeNull();
  });

  it('is disabled with the reason when the role or the organization does not allow it', async () => {
    server({ download: 'none' });
    renderApp({ path: '/clusters/c1/backups/nightly' });
    const button = await screen.findByRole('button', { name: 'Download contents' });
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    expect(button.getAttribute('title') ?? '').toMatch(/backup:download.*organization/);
  });

  it('is disabled for a backup that has no contents yet', async () => {
    server({ phase: 'InProgress' });
    renderApp({ path: '/clusters/c1/backups/nightly' });
    const button = await screen.findByRole('button', { name: 'Download contents' });
    await waitFor(() => {
      expect(button.getAttribute('title') ?? '').toMatch(/no contents/);
    });
    expect(button).toBeDisabled();
  });

  it('says what went wrong and offers no link when the agent could not get one', async () => {
    const user = userEvent.setup();
    server({ fail: true });
    renderApp({ path: '/clusters/c1/backups/nightly' });
    await user.click(await screen.findByRole('button', { name: 'Download contents' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not obtain a download link/);
    expect(screen.queryByRole('link', { name: /Download backup contents/ })).toBeNull();
  });
});
