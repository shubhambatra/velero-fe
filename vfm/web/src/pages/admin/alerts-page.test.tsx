/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies and fixtures are untyped JSON on purpose */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderApp, stubFetch } from '@/test/utils';

const USER = { id: 'u1', email: 'a@b.co', name: null, isPlatformAdmin: false, mfaEnabled: false };
const PROBLEM = 'application/problem+json';

interface Call {
  method: string;
  path: string;
  body: any;
}

const CLUSTERS = [
  { id: 'c1', name: 'prod-eu' },
  { id: 'c2', name: 'dev' },
];
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function server(
  init: {
    role?: string;
    rules?: any[];
    channels?: any[];
    events?: any[];
    onCall?: (c: Call) => Response | undefined;
  } = {},
) {
  const calls: Call[] = [];
  const state = {
    rules: init.rules ?? [],
    channels: init.channels ?? [],
    events: init.events ?? [],
  };
  stubFetch((url, req) => {
    const u = new URL(url, 'http://x');
    const path = u.pathname.replace('/api/v1', '') + u.search;
    const method = req?.method ?? 'GET';
    if (path === '/auth/me') return jsonResponse({ user: USER });
    if (path === '/me/orgs')
      return jsonResponse({
        orgs: [
          { id: 'o1', name: 'Acme', slug: 'acme', orgRole: init.role ?? 'OWNER', active: true },
        ],
      });
    const call: Call = {
      method,
      path,
      body: typeof req?.body === 'string' ? JSON.parse(req.body) : undefined,
    };
    calls.push(call);
    const custom = init.onCall?.(call);
    if (custom !== undefined) return custom;
    if (path === '/orgs/o1/clusters') return jsonResponse({ clusters: CLUSTERS });
    if (path === '/orgs/o1/channels' && method === 'GET')
      return jsonResponse({ channels: state.channels });
    if (path === '/orgs/o1/alerts/rules' && method === 'GET')
      return jsonResponse({ rules: state.rules });
    if (path.startsWith('/orgs/o1/alerts/events'))
      return jsonResponse({ events: state.events, nextCursor: null });
    if (method === 'POST' && path === '/orgs/o1/alerts/rules')
      return jsonResponse({ id: 'r-new', ...call.body }, { status: 201 });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse({});
  });
  return { calls, state };
}

const RULE = {
  id: 'r1',
  name: 'Failed backups',
  type: 'BACKUP_FAILED',
  scope: { clusterIds: ['c1'] },
  params: { lookbackHours: 24, includePartiallyFailed: true, renotifyMinutes: 240 },
  channelIds: ['ch1'],
  enabled: true,
  firing: 2,
};
const WEBHOOK = {
  id: 'ch1',
  name: 'pager',
  type: 'WEBHOOK',
  config: { destination: 'https://hooks.example.com', signed: true },
};
const MAIL = {
  id: 'ch2',
  name: 'ops mail',
  type: 'EMAIL',
  config: { to: ['ops@acme.test', 'oncall@acme.test'] },
};

const open = async (tab?: string) => {
  const user = userEvent.setup();
  renderApp({ path: '/admin/alerts' });
  await screen.findByRole('heading', { name: 'Alerts' });
  if (tab !== undefined) await user.click(screen.getByRole('button', { name: tab }));
  return user;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('alerts: rules', () => {
  it('lists each rule with what it watches, who it tells and what is firing', async () => {
    server({ rules: [RULE], channels: [WEBHOOK] });
    await open();
    const row = (await screen.findByText('Failed backups')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Backup failed')).toBeVisible();
    expect(within(row).getByText('prod-eu')).toBeVisible();
    expect(within(row).getByText('pager')).toBeVisible();
    expect(within(row).getByText('2 firing')).toBeVisible();
    expect(within(row).getByText('On')).toBeVisible();
  });

  it('says so when there are none', async () => {
    server();
    await open();
    expect(await screen.findByText(/No rules yet/)).toBeVisible();
  });

  it('creates a rule with its type’s settings as numbers, scoped to the clusters ticked', async () => {
    const { calls } = server({ channels: [WEBHOOK, MAIL] });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    await user.type(screen.getByLabelText('Name'), 'Agents');
    await user.selectOptions(screen.getByLabelText(/Alert when/), 'AGENT_DISCONNECTED');
    const minutes = screen.getByLabelText(/Disconnected for/);
    await user.clear(minutes);
    await user.type(minutes, '20');
    await user.click(screen.getByLabelText('prod-eu'));
    await user.click(screen.getByLabelText('pager'));
    await user.click(screen.getByRole('button', { name: 'Create rule' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/orgs/o1/alerts/rules')).toBe(
        true,
      );
    });
    const post = calls.find((c) => c.method === 'POST' && c.path === '/orgs/o1/alerts/rules');
    expect(post?.body).toEqual({
      name: 'Agents',
      type: 'AGENT_DISCONNECTED',
      scope: { clusterIds: ['c1'] },
      params: { minutes: 20, renotifyMinutes: 240 },
      channelIds: ['ch1'],
      enabled: true,
    });
  });

  it('shows the settings of the type chosen and resets them when it changes', async () => {
    server({ channels: [WEBHOOK] });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    expect(screen.getByLabelText(/Only failures from the last/)).toHaveValue(24);
    expect(screen.getByLabelText(/Include partially failed/)).toBeChecked();
    await user.selectOptions(screen.getByLabelText(/Alert when/), 'SCHEDULE_MISSED');
    expect(screen.queryByLabelText(/Only failures/)).toBeNull();
    expect(screen.getByLabelText(/Late after/)).toHaveValue(1.5);
    await user.selectOptions(screen.getByLabelText(/Alert when/), 'BSL_UNAVAILABLE');
    expect(screen.getByLabelText(/Repeat while it lasts/)).toHaveValue(240);
  });

  it('points to the channels tab when there are none to choose', async () => {
    server();
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    expect(screen.getByText(/nobody would be told/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add a channel' }));
    expect(await screen.findByRole('button', { name: 'New channel' })).toBeVisible();
  });

  it('edits a rule without letting its type change, and sends only what the rule accepts', async () => {
    const { calls } = server({ rules: [RULE], channels: [WEBHOOK] });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Edit Failed backups' }));
    expect(screen.getByLabelText(/Alert when/)).toBeDisabled();
    const hours = screen.getByLabelText(/Only failures from the last/);
    await user.clear(hours);
    await user.type(hours, '6');
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/orgs/o1/alerts/rules/r1');
    expect(patch?.body).not.toHaveProperty('type');
    expect(patch?.body.params.lookbackHours).toBe(6);
    expect(patch?.body.scope).toEqual({ clusterIds: ['c1'] });
  });

  it('turns a rule off from the list', async () => {
    const { calls } = server({ rules: [RULE], channels: [WEBHOOK] });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Turn off Failed backups' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false });
    });
  });

  it('asks for the rule’s name before deleting it', async () => {
    const { calls } = server({ rules: [RULE], channels: [WEBHOOK] });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Delete Failed backups' }));
    const confirm = screen.getByRole('button', { name: 'Delete rule' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type Failed backups to confirm/), 'Failed backups');
    await user.click(confirm);
    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'DELETE' && c.path === '/orgs/o1/alerts/rules/r1'),
      ).toBe(true);
    });
  });

  it('shows the control plane’s reason when a rule is refused', async () => {
    server({
      channels: [WEBHOOK],
      onCall: (c) =>
        c.method === 'POST' && c.path === '/orgs/o1/alerts/rules'
          ? jsonResponse(
              {
                type: 'about:blank',
                title: 'Bad Request',
                status: 400,
                detail: 'params: minutes: too small',
              },
              { status: 400, contentType: PROBLEM },
            )
          : undefined,
    });
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    await user.type(screen.getByLabelText('Name'), 'x');
    await user.click(screen.getByRole('button', { name: 'Create rule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('params: minutes: too small');
  });
});

describe('alerts: channels', () => {
  it('lists channels by their origin and recipients, never a secret path', async () => {
    server({ channels: [WEBHOOK, MAIL] });
    await open('Channels');
    expect(await screen.findByText('https://hooks.example.com')).toBeVisible();
    expect(screen.getByText('ops@acme.test, oncall@acme.test')).toBeVisible();
    expect(screen.getByText('Webhook (signed)')).toBeVisible();
  });

  it('creates a webhook and shows its signing secret once', async () => {
    const { calls } = server({
      onCall: (c) =>
        c.method === 'POST' && c.path === '/orgs/o1/channels'
          ? jsonResponse(
              { ...WEBHOOK, id: 'new', name: c.body.name, secret: 'whsec_ABC123' },
              { status: 201 },
            )
          : undefined,
    });
    const user = await open('Channels');
    await user.click(await screen.findByRole('button', { name: 'New channel' }));
    await user.type(screen.getByLabelText('Name'), 'pager');
    await user.type(screen.getByLabelText('URL'), 'https://hooks.example.com/x?token=abc');
    await user.click(screen.getByRole('button', { name: 'Create channel' }));
    expect(await screen.findByLabelText('Signing secret')).toHaveTextContent('whsec_ABC123');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'pager',
      type: 'WEBHOOK',
      config: { url: 'https://hooks.example.com/x?token=abc' },
    });
    await user.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(screen.queryByLabelText('Signing secret')).toBeNull();
  });

  it('creates an email channel from a pasted list of addresses', async () => {
    const { calls } = server();
    const user = await open('Channels');
    await user.click(await screen.findByRole('button', { name: 'New channel' }));
    await user.type(screen.getByLabelText('Name'), 'mail');
    await user.selectOptions(screen.getByLabelText('Kind'), 'EMAIL');
    await user.type(screen.getByLabelText(/Recipients/), 'a@acme.test, b@acme.test;\nc@acme.test');
    await user.click(screen.getByRole('button', { name: 'Create channel' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.path === '/orgs/o1/channels')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'POST')?.body.config).toEqual({
      to: ['a@acme.test', 'b@acme.test', 'c@acme.test'],
    });
  });

  it('shows why a destination was refused', async () => {
    server({
      onCall: (c) =>
        c.method === 'POST' && c.path === '/orgs/o1/channels'
          ? jsonResponse(
              {
                type: 'about:blank',
                title: 'Bad Request',
                status: 400,
                detail: 'url: that address is not allowed as a destination',
              },
              { status: 400, contentType: PROBLEM },
            )
          : undefined,
    });
    const user = await open('Channels');
    await user.click(await screen.findByRole('button', { name: 'New channel' }));
    await user.type(screen.getByLabelText('Name'), 'bad');
    await user.type(screen.getByLabelText('URL'), 'https://127.0.0.1/x');
    await user.click(screen.getByRole('button', { name: 'Create channel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not allowed as a destination/);
  });

  it('sends a test and says whether it arrived', async () => {
    let ok = true;
    server({
      channels: [WEBHOOK],
      onCall: (c) =>
        c.method === 'POST' && c.path === '/orgs/o1/channels/ch1/test'
          ? jsonResponse(
              ok ? { ok: true } : { ok: false, error: 'the destination answered HTTP 500' },
            )
          : undefined,
    });
    const user = await open('Channels');
    await user.click(await screen.findByRole('button', { name: 'Send a test through pager' }));
    expect(await screen.findByText('Test sent.')).toBeVisible();
    ok = false;
    await user.click(screen.getByRole('button', { name: 'Send a test through pager' }));
    expect(
      await screen.findByText('Test failed: the destination answered HTTP 500.'),
    ).toBeVisible();
  });

  it('keeps the current address when a channel is edited without a new one', async () => {
    const { calls } = server({ channels: [WEBHOOK] });
    const user = await open('Channels');
    await user.click(await screen.findByRole('button', { name: 'Edit pager' }));
    expect(screen.getByLabelText('URL')).toHaveValue('');
    expect(screen.getByLabelText('URL')).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/keep the current/),
    );
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'pager 2');
    await user.click(screen.getByRole('button', { name: 'Save channel' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'pager 2' });
  });

  it('shows a new secret once after asking for one', async () => {
    server({
      channels: [WEBHOOK],
      onCall: (c) =>
        c.method === 'PATCH' ? jsonResponse({ ...WEBHOOK, secret: 'whsec_NEW' }) : undefined,
    });
    const user = await open('Channels');
    await user.click(await screen.findByRole('button', { name: 'Make a new secret for pager' }));
    expect(await screen.findByLabelText('Signing secret')).toHaveTextContent('whsec_NEW');
  });

  it('asks for the channel’s name before deleting it', async () => {
    const { calls } = server({ channels: [WEBHOOK] });
    const user = await open('Channels');
    await user.click(await screen.findByRole('button', { name: 'Delete pager' }));
    await user.type(screen.getByLabelText(/Type pager to confirm/), 'pager');
    await user.click(screen.getByRole('button', { name: 'Delete channel' }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/orgs/o1/channels/ch1')).toBe(
        true,
      );
    });
  });
});

describe('alerts: history', () => {
  const EVENT = {
    id: 'e1',
    ruleId: 'r1',
    ruleName: 'Failed backups',
    ruleType: 'BACKUP_FAILED',
    clusterId: 'c1',
    clusterName: 'prod-eu',
    state: 'FIRING',
    fingerprint: 'backup-failed:velero/nightly',
    payload: {
      backup: 'nightly-1',
      schedule: 'nightly',
      phase: 'Failed',
      reason: 'BSL unavailable',
    },
    firedAt: hoursAgo(2),
    resolvedAt: null,
    lastNotifiedAt: hoursAgo(2),
    deliveries: [
      {
        channelId: 'ch1',
        channelName: 'pager',
        kind: 'fired',
        ok: true,
        error: null,
        createdAt: hoursAgo(2),
      },
      {
        channelId: 'ch2',
        channelName: 'ops mail',
        kind: 'fired',
        ok: false,
        error: 'email delivery is not configured on this server',
        createdAt: hoursAgo(2),
      },
    ],
  };

  it('shows what fired, on which cluster, and what became of each message', async () => {
    server({ events: [EVENT] });
    await open('History');
    const row = (await screen.findByText('Failed backups')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Firing')).toBeVisible();
    expect(within(row).getByText('prod-eu')).toBeVisible();
    expect(
      within(row).getByText(/Backup nightly-1 \(schedule nightly\) failed: BSL unavailable/),
    ).toBeVisible();
    expect(within(row).getByText(/fired · pager/)).toBeVisible();
    expect(within(row).getByText('email delivery is not configured on this server')).toBeVisible();
    expect(within(row).getByText('Delivered:')).toBeInTheDocument();
    expect(within(row).getByText('Failed:')).toBeInTheDocument();
  });

  it('filters by state through the server', async () => {
    const { calls } = server({ events: [EVENT] });
    const user = await open('History');
    await screen.findByText('Failed backups');
    await user.selectOptions(screen.getByLabelText('Show alerts'), 'RESOLVED');
    await waitFor(() => {
      expect(
        calls.some((c) => c.path.includes('/alerts/events') && c.path.includes('state=RESOLVED')),
      ).toBe(true);
    });
  });

  it('says when nothing has fired', async () => {
    server();
    await open('History');
    expect(await screen.findByText('Nothing has fired yet.')).toBeVisible();
  });

  it('loads older alerts a page at a time', async () => {
    const calls: string[] = [];
    server({
      onCall: (c) => {
        if (!c.path.startsWith('/orgs/o1/alerts/events')) return undefined;
        calls.push(c.path);
        return c.path.includes('cursor=e1')
          ? jsonResponse({
              events: [{ ...EVENT, id: 'e0', ruleName: 'Older rule' }],
              nextCursor: null,
            })
          : jsonResponse({ events: [EVENT], nextCursor: 'e1' });
      },
    });
    const user = await open('History');
    await user.click(await screen.findByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('Older rule')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });
});

describe('alerts: access', () => {
  it('is in the admin navigation for an owner', async () => {
    server();
    renderApp({ path: '/admin/alerts' });
    expect(await screen.findByRole('link', { name: 'Alerts' })).toBeVisible();
  });
});
