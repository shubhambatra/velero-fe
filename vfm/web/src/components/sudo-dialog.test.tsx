import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SudoDialog, SudoProvider } from '@/components/sudo-dialog';
import { api } from '@/lib/client';
import { jsonResponse, stubFetch } from '@/test/utils';

const bodyText = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

describe('sudo dialog', () => {
  it('posts the password to /auth/sudo and reports success', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch(() => jsonResponse({ expiresAt: 'x' }));
    const onDone = vi.fn();
    render(<SudoDialog onDone={onDone} />);

    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await vi.waitFor(() => {
      expect(onDone).toHaveBeenCalledWith(true);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/auth/sudo');
    expect(JSON.parse(bodyText(init))).toEqual({ password: 'hunter2hunter2' });
  });

  it('stays open with the error when the password is wrong', async () => {
    const user = userEvent.setup();
    stubFetch(() =>
      jsonResponse(
        { title: 'Unauthorized', status: 401, detail: 're-authentication failed' },
        { status: 401, contentType: 'application/problem+json' },
      ),
    );
    const onDone = vi.fn();
    render(<SudoDialog onDone={onDone} />);

    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('re-authentication failed')).toBeVisible();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('opens from a sudoRequired failure and retries the original request', async () => {
    const user = userEvent.setup();
    let deletes = 0;
    stubFetch((url, init) => {
      if (url.endsWith('/auth/sudo')) {
        return jsonResponse({ expiresAt: 'x' });
      }
      deletes += 1;
      return init?.method === 'DELETE' && deletes === 1
        ? jsonResponse(
            { title: 'Forbidden', status: 403, sudoRequired: true },
            { status: 403, contentType: 'application/problem+json' },
          )
        : jsonResponse({ done: true });
    });
    render(
      <SudoProvider>
        <p>app</p>
      </SudoProvider>,
    );

    const pending = api<{ done: boolean }>('/orgs/o/teams/t', { method: 'DELETE' });
    await user.type(await screen.findByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await expect(pending).resolves.toEqual({ done: true });
    expect(deletes).toBe(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
