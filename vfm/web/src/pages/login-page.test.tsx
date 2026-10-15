import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const PROBLEM = 'application/problem+json';

describe('login page', () => {
  it('redirects an anonymous visitor from / to the login form', async () => {
    stubFetch((url) =>
      url.endsWith('/auth/me')
        ? jsonResponse(
            { title: 'Unauthorized', status: 401 },
            { status: 401, contentType: PROBLEM },
          )
        : jsonResponse({ status: 'ok' }),
    );
    renderApp({ path: '/' });

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  it('shows a generic message for ?sso=failed', async () => {
    stubFetch(() =>
      jsonResponse({ title: 'Unauthorized', status: 401 }, { status: 401, contentType: PROBLEM }),
    );
    renderApp({ path: '/login?sso=failed' });

    expect(await screen.findByRole('alert')).toHaveTextContent(/single sign-on failed/i);
  });

  it('posts credentials and goes to /mfa when a second factor is owed', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/auth/login') && init?.method === 'POST') {
        return jsonResponse({
          user: { id: 'u', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: true },
          mfaPendingReason: 'challenge',
        });
      }
      if (url.endsWith('/auth/me')) {
        return jsonResponse(
          { title: 'Forbidden', status: 403, mfaRequired: true, mfaPendingReason: 'challenge' },
          { status: 403, contentType: PROBLEM },
        );
      }
      return jsonResponse({ status: 'ok' });
    });
    renderApp({ path: '/login' });

    await user.type(await screen.findByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    const login = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/auth/login'),
    );
    const sent = login?.[1]?.body;
    expect(JSON.parse(typeof sent === 'string' ? sent : '')).toEqual({
      email: 'a@b.co',
      password: 'correct horse',
    });
  });

  it('shows the server detail when credentials are wrong', async () => {
    const user = userEvent.setup();
    stubFetch((url) =>
      url.endsWith('/auth/login')
        ? jsonResponse(
            { title: 'Unauthorized', status: 401, detail: 'invalid email or password' },
            { status: 401, contentType: PROBLEM },
          )
        : jsonResponse({ status: 'ok' }),
    );
    renderApp({ path: '/login' });

    await user.type(await screen.findByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('invalid email or password')).toBeVisible();
  });

  it('lists SSO providers for an org slug as links to the start endpoint', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch((url) =>
      url.includes('/auth/oidc/providers')
        ? jsonResponse({ providers: [{ id: 'p1', name: 'Okta' }] })
        : jsonResponse({ status: 'ok' }),
    );
    renderApp({ path: '/login' });

    await user.type(await screen.findByLabelText('Organization slug'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Find sign-in options' }));

    const link = await screen.findByRole('link', { name: 'Continue with Okta' });
    expect(link).toHaveAttribute('href', '/api/v1/auth/oidc/p1/start');
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([u]) => typeof u === 'string' && u.endsWith('providers?org=acme'),
        ),
      ).toBe(true);
    });
  });
});
