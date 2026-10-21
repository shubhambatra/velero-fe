import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: true };

function server(settings: Record<string, unknown> = {}) {
  const patches: unknown[] = [];
  stubFetch((url, init) => {
    if (url.endsWith('/auth/me')) return jsonResponse({ user: USER });
    if (url.endsWith('/me/orgs')) {
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'OWNER', active: true }],
      });
    }
    if (url.endsWith('/orgs/o1') && init?.method === 'PATCH') {
      patches.push(JSON.parse(init.body as string));
      return jsonResponse({});
    }
    if (url.endsWith('/orgs/o1')) {
      return jsonResponse({ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'OWNER', settings });
    }
    return jsonResponse({ status: 'ok' });
  });
  return patches;
}

describe('audit log retention settings', () => {
  it('shows the current period and saves a new one', async () => {
    const user = userEvent.setup();
    const patches = server({ auditRetentionDays: 400 });
    renderApp({ path: '/admin/security' });

    const field = await screen.findByLabelText('Keep audit events for (days)');
    await waitFor(() => {
      expect(field).toHaveValue(400);
    });
    const save = screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement;
    expect(save).toBeDisabled(); // unchanged
    await user.clear(field);
    await user.type(field, '90');
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => {
      expect(patches).toContainEqual({ auditRetentionDays: 90 });
    });
  });

  it('will not send a period outside 30 to 3650 days', async () => {
    const user = userEvent.setup();
    const patches = server({ auditRetentionDays: 400 });
    renderApp({ path: '/admin/security' });

    const field = await screen.findByLabelText('Keep audit events for (days)');
    await waitFor(() => {
      expect(field).toBeEnabled();
    });
    await user.clear(field);
    await user.type(field, '7');
    expect(await screen.findByText('Between 30 and 3650 days.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Save' })[0]).toBeDisabled();
    await user.clear(field);
    await user.type(field, '99999');
    expect(screen.getAllByRole('button', { name: 'Save' })[0]).toBeDisabled();
    expect(patches).toEqual([]);
  });

  it('turns export-before-delete on and off', async () => {
    const user = userEvent.setup();
    const patches = server({ auditExportBeforeDelete: false });
    renderApp({ path: '/admin/security' });

    const box = await screen.findByRole('checkbox', {
      name: /Write events to a file before deleting/,
    });
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => {
      expect(patches).toContainEqual({ auditExportBeforeDelete: true });
    });
  });
});
