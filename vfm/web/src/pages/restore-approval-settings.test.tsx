/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies and fixtures are untyped JSON on purpose */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

interface Call {
  method: string;
  path: string;
  body: any;
}

function server(
  init: {
    policy?: { required: boolean; fromOrg: boolean; fromCluster: boolean };
    manage?: string;
    settings?: Record<string, boolean>;
  } = {},
) {
  const calls: Call[] = [];
  let policy = init.policy ?? { required: false, fromOrg: false, fromCluster: false };
  let settings = init.settings ?? {};
  stubFetch((url, req) => {
    const u = new URL(url, 'http://x');
    const path = u.pathname.replace('/api/v1', '');
    const method = req?.method ?? 'GET';
    const body = typeof req?.body === 'string' ? JSON.parse(req.body) : undefined;
    if (path === '/auth/me') return jsonResponse({ user: USER });
    if (path === '/me/orgs')
      return jsonResponse({
        orgs: [{ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'OWNER', active: true }],
      });
    calls.push({ method, path, body });
    if (path === '/orgs/o1' && method === 'GET')
      return jsonResponse({ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'OWNER', settings });
    if (path === '/orgs/o1' && method === 'PATCH') {
      settings = { ...settings, ...body };
      return jsonResponse({ id: 'o1', name: 'Acme', slug: 'acme', orgRole: 'OWNER', settings });
    }
    if (path === '/orgs/o1/clusters/c1/restore-approval' && method === 'PUT') {
      policy = { ...policy, fromCluster: body.required, required: policy.fromOrg || body.required };
      return jsonResponse(policy);
    }
    if (path === '/orgs/o1/clusters/c1/restore-approval') return jsonResponse(policy);
    if (path === '/orgs/o1/clusters/c1/access')
      return jsonResponse({ access: { 'cluster:manage': init.manage ?? 'cluster' } });
    if (path === '/orgs/o1/clusters/c1/overview')
      return jsonResponse({
        cluster: CLUSTER,
        inventory: { snapshotId: 's', syncedAt: null, kinds: {} },
        locations: null,
        recentBackups: null,
        recentRestores: null,
      });
    return jsonResponse({ items: [], nextCursor: null });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the organization setting', () => {
  it('shows the requirement and turns it on', async () => {
    const user = userEvent.setup();
    const calls = server({ settings: { mfaRequired: true } });
    renderApp({ path: '/admin/security' });
    const box = await screen.findByLabelText(/Require approval of restores/);
    await waitFor(() => {
      expect(box).toBeEnabled();
    });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/a cluster cannot opt out/)).toBeVisible();
    await user.click(box);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        requireRestoreApproval: true,
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Require approval of restores/)).toBeChecked();
    });
  });

  it('shows it already on', async () => {
    server({ settings: { requireRestoreApproval: true } });
    renderApp({ path: '/admin/security' });
    await waitFor(() => {
      expect(screen.getByLabelText(/Require approval of restores/)).toBeChecked();
    });
  });
});

describe('the cluster setting', () => {
  it('turns approval on for one cluster', async () => {
    const user = userEvent.setup();
    const calls = server();
    renderApp({ path: '/clusters/c1' });
    const box = await screen.findByLabelText('Require approval of restores on this cluster');
    await waitFor(() => {
      expect(box).toBeEnabled();
    });
    await user.click(box);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ required: true });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Require approval of restores on this cluster')).toBeChecked();
    });
  });

  it('shows what the organization requires, and cannot be cleared here', async () => {
    server({ policy: { required: true, fromOrg: true, fromCluster: false } });
    renderApp({ path: '/clusters/c1' });
    const box = await screen.findByLabelText('Require approval of restores on this cluster');
    await waitFor(() => {
      expect(box).toBeChecked();
    });
    expect(box).toBeDisabled();
    expect(screen.getByText('Required by the organization.')).toBeVisible();
  });

  it('is read-only for someone who may not manage the cluster', async () => {
    server({ manage: 'none' });
    renderApp({ path: '/clusters/c1' });
    const box = await screen.findByLabelText('Require approval of restores on this cluster');
    await waitFor(() => {
      expect(screen.getByText(/You need the cluster:manage permission/)).toBeVisible();
    });
    expect(box).toBeDisabled();
  });
});
