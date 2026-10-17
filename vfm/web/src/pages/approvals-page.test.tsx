/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies and fixtures are untyped JSON on purpose */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = {
  id: 'u1',
  email: 'me@acme.test',
  name: null,
  isPlatformAdmin: false,
  mfaEnabled: false,
};
const PROBLEM = 'application/problem+json';
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const ahead = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

interface Call {
  method: string;
  path: string;
  body: any;
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  clusterId: 'c1',
  clusterName: 'prod-eu',
  status: 'PENDING_APPROVAL',
  requestedBy: { id: 'u2', email: 'dana@acme.test', name: 'Dana' },
  createdAt: ago(1),
  expiresAt: ahead(23),
  decidedAt: null,
  approvedBy: null,
  rejectedBy: null,
  decisionNote: null,
  canApprove: true,
  isMine: false,
  summary: {
    backupName: 'nightly-1',
    scheduleName: null,
    namespaces: ['shop', 'cart'],
    namespaceMapping: { shop: 'shop-restored' },
    includesClusterResources: false,
    existingResourcePolicy: 'update',
    restorePVs: true,
  },
  ...over,
});

function server(
  init: {
    pending?: any[];
    decided?: any[];
    waiting?: number;
    onCall?: (c: Call) => Response | undefined;
  } = {},
) {
  const calls: Call[] = [];
  stubFetch((url, req) => {
    const u = new URL(url, 'http://x');
    const path = u.pathname.replace('/api/v1', '') + u.search;
    const method = req?.method ?? 'GET';
    if (path === '/auth/me') return jsonResponse({ user: USER });
    if (path === '/me/orgs')
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'MEMBER', active: true }],
      });
    const call: Call = {
      method,
      path,
      body: typeof req?.body === 'string' ? JSON.parse(req.body) : undefined,
    };
    calls.push(call);
    const custom = init.onCall?.(call);
    if (custom !== undefined) return custom;
    if (path === '/orgs/o1/approvals/count')
      return jsonResponse({
        waiting: init.waiting ?? (init.pending ?? []).filter((p) => p.canApprove).length,
      });
    if (path === '/orgs/o1/approvals?status=pending')
      return jsonResponse({ approvals: init.pending ?? [] });
    if (path === '/orgs/o1/approvals?status=decided')
      return jsonResponse({ approvals: init.decided ?? [] });
    return jsonResponse({}, { status: method === 'POST' ? 200 : 200 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the approvals page', () => {
  it('shows what is asked, by whom, and what it would touch', async () => {
    server({ pending: [item()] });
    renderApp({ path: '/approvals' });
    const card = (await screen.findByText('Restore on prod-eu')).closest(
      'div[class*="rounded"]',
    ) as HTMLElement;
    expect(within(card).getByText('Dana')).toBeVisible();
    expect(within(card).getByText('backup nightly-1')).toBeVisible();
    expect(within(card).getByText('shop → shop-restored, cart')).toBeVisible();
    expect(within(card).getByText('not included')).toBeVisible();
    expect(within(card).getByText('update it')).toBeVisible();
    expect(within(card).getByText('Expires')).toBeVisible();
  });

  it('describes a schedule source and an everything restore', async () => {
    server({
      pending: [
        item({
          summary: {
            backupName: null,
            scheduleName: 'nightly',
            namespaces: ['*'],
            namespaceMapping: {},
            includesClusterResources: true,
            existingResourcePolicy: null,
            restorePVs: null,
          },
        }),
      ],
    });
    renderApp({ path: '/approvals' });
    expect(await screen.findByText('latest backup of schedule nightly')).toBeVisible();
    expect(screen.getByText('all namespaces')).toBeVisible();
    expect(screen.getByText('included')).toBeVisible();
    expect(screen.getByText('leave it (default)')).toBeVisible();
  });

  it('approves with one click and asks the control plane to', async () => {
    const user = userEvent.setup();
    const calls = server({ pending: [item()] });
    renderApp({ path: '/approvals' });
    await user.click(await screen.findByRole('button', { name: 'Approve the restore on prod-eu' }));
    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'POST' && c.path === '/orgs/o1/approvals/r1/approve'),
      ).toBe(true);
    });
  });

  it('rejects with a reason after a second step', async () => {
    const user = userEvent.setup();
    const calls = server({ pending: [item()] });
    renderApp({ path: '/approvals' });
    await user.click(await screen.findByRole('button', { name: 'Reject the restore on prod-eu' }));
    expect(calls.some((c) => c.path.endsWith('/reject'))).toBe(false);
    await user.type(screen.getByLabelText(/Reason/), 'wrong backup');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/orgs/o1/approvals/r1/reject')).toBe(true);
    });
    expect(calls.find((c) => c.path.endsWith('/reject'))?.body).toEqual({ note: 'wrong backup' });
  });

  it('rejects without a reason, and can back out of rejecting', async () => {
    const user = userEvent.setup();
    const calls = server({ pending: [item()] });
    renderApp({ path: '/approvals' });
    await user.click(await screen.findByRole('button', { name: 'Reject the restore on prod-eu' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Approve the restore on prod-eu' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reject the restore on prod-eu' }));
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => {
      expect(calls.find((c) => c.path.endsWith('/reject'))?.body).toEqual({});
    });
  });

  it('offers a person’s own request only a withdraw, with the reason for waiting', async () => {
    const user = userEvent.setup();
    const calls = server({
      pending: [
        item({
          canApprove: false,
          isMine: true,
          requestedBy: { id: 'u1', email: 'me@acme.test', name: null },
        }),
      ],
    });
    renderApp({ path: '/approvals' });
    expect(await screen.findByText('Waiting for someone else to approve')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reject/ })).toBeNull();
    expect(screen.getByText('me@acme.test (you)')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Withdraw the restore on prod-eu' }));
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.path === '/orgs/o1/clusters/c1/commands/r1/cancel',
        ),
      ).toBe(true);
    });
  });

  it('offers nothing on a request the caller can neither decide nor withdraw', async () => {
    server({ pending: [item({ canApprove: false, isMine: false })] });
    renderApp({ path: '/approvals' });
    await screen.findByText('Restore on prod-eu');
    expect(screen.queryByRole('button', { name: /Approve|Reject|Withdraw/ })).toBeNull();
  });

  it('shows the server’s reason when a decision is refused', async () => {
    const user = userEvent.setup();
    server({
      pending: [item()],
      onCall: (c) =>
        c.path.endsWith('/approve')
          ? jsonResponse(
              {
                type: 'about:blank',
                title: 'Conflict',
                status: 409,
                detail: 'the request is no longer waiting for approval',
              },
              { status: 409, contentType: PROBLEM },
            )
          : undefined,
    });
    renderApp({ path: '/approvals' });
    await user.click(await screen.findByRole('button', { name: 'Approve the restore on prod-eu' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'the request is no longer waiting for approval',
    );
  });

  it('says so when nothing is waiting, and when nothing was decided', async () => {
    const user = userEvent.setup();
    server();
    renderApp({ path: '/approvals' });
    expect(await screen.findByText('Nothing is waiting for approval.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Decided' }));
    expect(await screen.findByText('Nothing has been decided in the last 30 days.')).toBeVisible();
  });

  it('shows how decided requests ended', async () => {
    const user = userEvent.setup();
    server({
      decided: [
        item({
          id: 'a',
          status: 'SUCCEEDED',
          canApprove: false,
          approvedBy: { id: 'u3', email: 'lee@acme.test', name: 'Lee' },
          decidedAt: ago(2),
        }),
        item({
          id: 'b',
          status: 'REJECTED',
          canApprove: false,
          rejectedBy: { id: 'u3', email: 'lee@acme.test', name: 'Lee' },
          decisionNote: 'wrong backup',
          decidedAt: ago(3),
        }),
        item({ id: 'c', status: 'TIMED_OUT', canApprove: false, expiresAt: ago(5) }),
      ],
    });
    renderApp({ path: '/approvals' });
    await user.click(await screen.findByRole('button', { name: 'Decided' }));
    expect(await screen.findByText('Approved by Lee')).toBeVisible();
    expect(screen.getByText('Rejected by Lee: wrong backup')).toBeVisible();
    expect(screen.getByText('Expired: nobody decided in time')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Approve|Reject/ })).toBeNull();
  });
});

describe('the navigation', () => {
  it('has an Approvals link with the number waiting for this person', async () => {
    server({ pending: [item(), item({ id: 'r2' }), item({ id: 'r3', canApprove: false })] });
    renderApp({ path: '/approvals' });
    const link = await screen.findByRole('link', { name: /Approvals/ });
    await waitFor(() => {
      expect(within(link).getByLabelText('2 waiting for you')).toBeVisible();
    });
  });

  it('shows no badge when nothing waits for them', async () => {
    server({ pending: [item({ canApprove: false })] });
    renderApp({ path: '/approvals' });
    const link = await screen.findByRole('link', { name: /Approvals/ });
    await screen.findByText('Restore on prod-eu');
    expect(within(link).queryByLabelText(/waiting for you/)).toBeNull();
  });
});
