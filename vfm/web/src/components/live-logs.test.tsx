import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveLogsPanel, VeleroLogShortcuts } from '@/components/live-logs';
import { FakeEventSource } from '@/test/event-source';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

const PROBLEM = 'application/problem+json';
const BASE = '/api/v1/orgs/o1/clusters/c1';
const TARGET = { namespace: 'shop', pod: 'web-1', container: 'app' };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'log' ? 480 : 20;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
});

let calls: Call[];
let sessions: number;

/** The control plane, as far as the panel can tell. */
function controlPlane(
  start: (body: Record<string, unknown>) => Response | Promise<Response> = () =>
    jsonResponse({
      sessionId: `s${(++sessions).toString()}`,
      streamUrl: `log-sessions/s${sessions.toString()}/stream`,
      expiresAt: 'x',
    }),
) {
  calls = [];
  return stubFetch((url, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (method === 'POST' && url === `${BASE}/log-sessions`) {
      return start(body as Record<string, unknown>);
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return jsonResponse({});
  });
}

const posts = () => calls.filter((c) => c.method === 'POST');
const deletes = () => calls.filter((c) => c.method === 'DELETE').map((c) => c.url);

function panel(onClose = vi.fn()) {
  const view = renderWithProviders(
    <LiveLogsPanel orgId="o1" clusterId="c1" target={TARGET} onClose={onClose} />,
  );
  return { ...view, onClose };
}

async function opened(): Promise<FakeEventSource> {
  await waitFor(() => {
    expect(FakeEventSource.instances.length).toBeGreaterThan(0);
  });
  return FakeEventSource.last;
}

beforeEach(() => {
  sessions = 0;
  FakeEventSource.install();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the live log panel', () => {
  it('starts a session for the container and follows its stream with the login cookie', async () => {
    controlPlane();
    panel();
    const es = await opened();
    expect(posts()[0]?.body).toEqual({
      namespace: 'shop',
      pod: 'web-1',
      container: 'app',
      tailLines: 200,
      previous: false,
      timestamps: false,
    });
    expect(es.url).toBe(`${BASE}/log-sessions/s1/stream`);
    expect(es.withCredentials).toBe(true);
  });

  it('shows lines as they arrive, joining a line that was cut between chunks', async () => {
    controlPlane();
    panel();
    const es = await opened();
    act(() => {
      es.open();
      es.emit('chunk', { text: 'first line\nsecond ha' });
    });
    expect(await screen.findByText('first line')).toBeInTheDocument();
    act(() => {
      es.emit('chunk', { text: 'lf\n' });
    });
    expect(await screen.findByText('second half')).toBeInTheDocument();
    expect(screen.getByText('live')).toBeInTheDocument();
  });

  it('batches a burst of chunks into few renders and keeps every line', async () => {
    controlPlane();
    panel();
    const es = await opened();
    act(() => {
      es.open();
      for (let i = 0; i < 500; i++) es.emit('chunk', { text: `row ${i.toString()}\n` });
    });
    await waitFor(() => {
      expect(screen.getByText('500 lines')).toBeInTheDocument();
    });
  });

  it('says why a session ended, and closes the stream', async () => {
    controlPlane();
    panel();
    const es = await opened();
    act(() => {
      es.open();
      es.emit('chunk', { text: 'bye\n' });
      es.emit('ended', { reason: 'pod_gone', message: '' });
    });
    expect(await screen.findByText('The pod or container no longer exists.')).toBeInTheDocument();
    expect(es.closed).toBe(true);
    expect(screen.getByText('bye')).toBeInTheDocument();
    expect(screen.queryByText('live')).toBeNull();
  });

  it.each([
    ['denied', /agent’s policy does not allow/],
    ['evicted', /already serving its limit/],
    ['timeout', /30-minute limit/],
    ['idle', /No one was watching/],
    ['revoked', /permission to read logs here was removed/],
    ['completed', /read to its end/],
  ])('explains an end by %s', async (reason, text) => {
    controlPlane();
    panel();
    const es = await opened();
    act(() => {
      es.emit('ended', { reason, message: '' });
    });
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('shows a refusal from the control plane and opens no stream', async () => {
    controlPlane(() =>
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'The agent’s policy does not allow logs from namespace “shop”.',
        },
        { status: 403, contentType: PROBLEM },
      ),
    );
    panel();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /policy does not allow logs from namespace/,
    );
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.getByText('No lines.')).toBeInTheDocument();
  });

  it.each([
    [403, 'You may not read logs in this namespace.'],
    [409, 'The agent for this cluster is not connected.'],
    [429, 'You already have 5 log sessions open.'],
  ])('shows the reason for a %s', async (status, detail) => {
    controlPlane(() =>
      jsonResponse(
        { type: 'about:blank', title: 'No', status, detail },
        { status, contentType: PROBLEM },
      ),
    );
    panel();
    expect(await screen.findByRole('alert')).toHaveTextContent(detail);
  });

  it('does not reconnect by itself when the stream drops', async () => {
    controlPlane();
    panel();
    const es = await opened();
    act(() => {
      es.open();
      es.emit('chunk', { text: 'kept\n' });
    });
    await screen.findByText('kept');
    act(() => {
      es.fail();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection .* was lost/);
    expect(es.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(screen.getByText('kept')).toBeInTheDocument();
  });

  it('ends the session on the server when the panel is closed', async () => {
    const user = userEvent.setup();
    controlPlane();
    const { onClose } = panel();
    const es = await opened();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(es.closed).toBe(true);
    await waitFor(() => {
      expect(deletes()).toEqual([`${BASE}/log-sessions/s1`]);
    });
  });

  it('ends the session on the server when the page leaves (the browser disconnects)', async () => {
    controlPlane();
    const { unmount } = panel();
    const es = await opened();
    unmount();
    expect(es.closed).toBe(true);
    await waitFor(() => {
      expect(deletes()).toEqual([`${BASE}/log-sessions/s1`]);
    });
  });

  it('asks the server to stop from pagehide, for a tab that is closing', async () => {
    const fetchMock = controlPlane();
    panel();
    await opened();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    const keepalive = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'DELETE' && init.keepalive === true,
    );
    expect(keepalive?.[0]).toBe(`${BASE}/log-sessions/s1`);
    expect(keepalive?.[1]?.credentials).toBe('include');
  });

  it('stops on request and says so', async () => {
    const user = userEvent.setup();
    controlPlane();
    panel();
    const es = await opened();
    act(() => {
      es.open();
    });
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('You stopped the log.')).toBeInTheDocument();
    expect(es.closed).toBe(true);
    expect(deletes()).toContain(`${BASE}/log-sessions/s1`);
  });

  it('ends a session whose start answered after it was stopped', async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => undefined;
    controlPlane(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    panel();
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    release(
      jsonResponse({ sessionId: 'late', streamUrl: 'log-sessions/late/stream', expiresAt: 'x' }),
    );
    await waitFor(() => {
      expect(deletes()).toContain(`${BASE}/log-sessions/late`);
    });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('restarts with the chosen options, ending the old session first', async () => {
    const user = userEvent.setup();
    controlPlane();
    panel();
    const first = await opened();
    await user.selectOptions(screen.getByLabelText('Start with the last'), '1000');
    await user.click(screen.getByLabelText('Timestamps'));
    await user.click(screen.getByLabelText(/Previous container/));
    await user.click(screen.getByRole('button', { name: 'Restart with these' }));
    await waitFor(() => {
      expect(posts()).toHaveLength(2);
    });
    expect(posts()[1]?.body).toMatchObject({ tailLines: 1000, previous: true, timestamps: true });
    expect(first.closed).toBe(true);
    expect(deletes()).toContain(`${BASE}/log-sessions/s1`);
    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(2);
    });
  });

  it('clears the earlier log when it restarts', async () => {
    const user = userEvent.setup();
    controlPlane();
    panel();
    const es = await opened();
    act(() => {
      es.emit('chunk', { text: 'old\n' });
    });
    await screen.findByText('old');
    await user.click(screen.getByRole('button', { name: 'Restart with these' }));
    await waitFor(() => {
      expect(screen.queryByText('old')).toBeNull();
    });
  });
});

describe('the Velero shortcuts', () => {
  function shortcuts(response: () => Response) {
    stubFetch((url) => (url === `${BASE}/log-shortcuts` ? response() : jsonResponse({})));
  }
  const open = vi.fn();
  afterEach(() => {
    open.mockReset();
  });

  it('offers the Velero server and each node agent and opens the one clicked', async () => {
    const user = userEvent.setup();
    shortcuts(() =>
      jsonResponse({
        namespace: 'velero',
        server: [{ pod: 'velero-abc', container: 'velero', node: 'n1' }],
        nodeAgent: [
          { pod: 'node-agent-1', container: 'node-agent', node: 'n1' },
          { pod: 'node-agent-2', container: 'node-agent', node: 'n2' },
        ],
      }),
    );
    renderWithProviders(<VeleroLogShortcuts orgId="o1" clusterId="c1" onOpen={open} />);
    const group = await screen.findByRole('group', { name: 'Velero logs' });
    await user.click(within(group).getByRole('button', { name: 'Velero server' }));
    expect(open).toHaveBeenLastCalledWith({
      namespace: 'velero',
      pod: 'velero-abc',
      container: 'velero',
    });
    await user.click(within(group).getByRole('button', { name: 'Node agent on n2' }));
    expect(open).toHaveBeenLastCalledWith({
      namespace: 'velero',
      pod: 'node-agent-2',
      container: 'node-agent',
    });
  });

  it.each([
    ['no namespace known', { namespace: null, server: [], nodeAgent: [] }],
    ['no Velero pods found', { namespace: 'velero', server: [], nodeAgent: [] }],
  ])('shows nothing when there is %s', async (_name, body) => {
    shortcuts(() => jsonResponse(body));
    const { container } = renderWithProviders(
      <VeleroLogShortcuts orgId="o1" clusterId="c1" onOpen={open} />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing, and no error, when the person may not read these logs', async () => {
    shortcuts(() =>
      jsonResponse(
        { type: 'about:blank', title: 'Forbidden', status: 403 },
        { status: 403, contentType: PROBLEM },
      ),
    );
    const { container } = renderWithProviders(
      <VeleroLogShortcuts orgId="o1" clusterId="c1" onOpen={open} />,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
  });
});
