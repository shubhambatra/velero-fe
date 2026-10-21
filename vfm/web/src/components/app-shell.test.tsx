import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { PRODUCT_NAME } from '@vfm/shared';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

describe('application shell', () => {
  beforeEach(() => {
    // The shell polls the probes; answering them keeps these assertions about
    // the shell rather than about connectivity.
    stubFetch((url) => {
      if (url.endsWith('/auth/me')) {
        return jsonResponse({
          user: { id: 'u', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false },
        });
      }
      if (url.endsWith('/me/orgs')) {
        return jsonResponse({
          orgs: [{ id: 'o', name: 'Acme', slug: 'acme', orgRole: 'MEMBER', active: true }],
        });
      }
      return jsonResponse({ status: 'ok' });
    });
  });

  it('renders the overview page inside the landmark structure', async () => {
    renderApp();

    expect(await screen.findByRole('heading', { level: 1, name: 'Fleet overview' })).toBeVisible();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('takes the product name from @vfm/shared, including the document title', async () => {
    renderApp();

    expect(await screen.findByText(PRODUCT_NAME)).toBeInTheDocument();
    expect(document.title).toBe(PRODUCT_NAME);
  });

  it('offers a skip link that targets the main region', async () => {
    renderApp();

    const skipLink = await screen.findByRole('link', { name: 'Skip to content' });

    expect(skipLink).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    // The skip link has to be the first thing a keyboard user reaches.
    expect(skipLink.compareDocumentPosition(screen.getByRole('banner'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('has no placeholder entries: every navigation item is a working link', async () => {
    renderApp();

    await screen.findByRole('banner');
    const nav = screen.getByRole('navigation', { name: /main|primary|sections/i });
    // Backups, restores and schedules live under each cluster; the top level must not pretend otherwise.
    expect(within(nav).queryByRole('button', { name: 'Backups' })).toBeNull();
    expect(
      within(nav)
        .queryAllByRole('button')
        .filter((b) => b.hasAttribute('disabled')),
    ).toEqual([]);
  });

  it('keeps the shell around the not-found page for an unknown URL', async () => {
    renderApp({ path: '/nope' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the fleet overview' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
