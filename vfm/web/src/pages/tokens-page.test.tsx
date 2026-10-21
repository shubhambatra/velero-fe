import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false };
const SECRET = 'vfm_' + 'x'.repeat(43);

function server(created: { value: boolean }) {
  return stubFetch((url, init) => {
    if (url.endsWith('/auth/me')) {
      return jsonResponse({ user: USER });
    }
    if (url.endsWith('/me/orgs')) {
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'MEMBER', active: true }],
      });
    }
    if (url.endsWith('/orgs/o1/tokens') && init?.method === 'POST') {
      created.value = true;
      return jsonResponse({ id: 't1', name: 'ci', token: SECRET }, { status: 201 });
    }
    if (url.endsWith('/orgs/o1/tokens')) {
      return jsonResponse({
        tokens: created.value
          ? [
              {
                id: 't1',
                name: 'ci',
                prefix: SECRET.slice(0, 12),
                permissions: null,
                clusterIds: null,
                expiresAt: null,
                lastUsedAt: null,
                revokedAt: null,
                createdAt: new Date().toISOString(),
              },
            ]
          : [],
      });
    }
    return jsonResponse({ status: 'ok' });
  });
}

describe('API tokens page', () => {
  it('shows the secret once and keeps it out of storage', async () => {
    const user = userEvent.setup();
    server({ value: false });
    renderApp({ path: '/tokens' });

    await user.type(await screen.findByLabelText('Name'), 'ci');
    await user.click(screen.getByRole('button', { name: 'Create token' }));

    expect(await screen.findByText(SECRET)).toBeVisible();
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        expect(store.getItem(store.key(i) ?? '') ?? '').not.toContain(SECRET);
      }
    }

    await user.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByText(SECRET)).toBeNull();
    // The list shows the prefix only.
    expect(await screen.findByText(`${SECRET.slice(0, 12)}…`)).toBeVisible();
  });

  it('lists permissions to limit a token to', async () => {
    const user = userEvent.setup();
    server({ value: false });
    renderApp({ path: '/tokens' });

    await user.click(await screen.findByLabelText('Limit to specific permissions'));
    expect(screen.getByLabelText('backup:read')).toBeVisible();
    expect(screen.getByLabelText('cluster:manage')).toBeVisible();
  });
});
