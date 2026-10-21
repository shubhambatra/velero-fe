import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const PROBLEM = 'application/problem+json';
const anonymous = () =>
  jsonResponse({ title: 'Unauthorized', status: 401 }, { status: 401, contentType: PROBLEM });

describe('invite page', () => {
  it('registers with the token from the link and lands in the app', async () => {
    const user = userEvent.setup();
    let registered = false;
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/invites/register') && init?.method === 'POST') {
        registered = true;
        return jsonResponse({ orgId: 'o1', mfaPendingReason: null }, { status: 201 });
      }
      if (url.endsWith('/auth/me')) {
        return registered
          ? jsonResponse({
              user: {
                id: 'u',
                email: 'a@b.co',
                name: null,
                isPlatformAdmin: false,
                mfaEnabled: false,
              },
            })
          : anonymous();
      }
      if (url.endsWith('/me/orgs')) {
        return jsonResponse({ orgs: [] });
      }
      return jsonResponse({ status: 'ok' });
    });
    renderApp({ path: '/invite?token=abc123token' });

    await user.type(await screen.findByLabelText('Password'), 'a-long-enough-passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Fleet overview' })).toBeVisible();
    const call = fetchMock.mock.calls.find(
      ([u]) => typeof u === 'string' && u.endsWith('/invites/register'),
    );
    const body = JSON.parse(typeof call?.[1]?.body === 'string' ? call[1].body : '{}') as {
      token?: string;
    };
    expect(body.token).toBe('abc123token');
  });

  it('shows the server’s single generic refusal', async () => {
    const user = userEvent.setup();
    stubFetch((url) =>
      url.endsWith('/invites/register')
        ? jsonResponse(
            { title: 'Bad Request', status: 400, detail: 'invalid or expired invitation' },
            { status: 400, contentType: PROBLEM },
          )
        : anonymous(),
    );
    renderApp({ path: '/invite?token=nope' });

    await user.type(await screen.findByLabelText('Password'), 'a-long-enough-passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid or expired invitation');
  });

  it('explains a link with no token', async () => {
    stubFetch(() => anonymous());
    renderApp({ path: '/invite' });

    expect(await screen.findByText(/missing its token/i)).toBeVisible();
  });
});
