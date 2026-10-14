import { describe, expect, it } from 'vitest';

import {
  apiFetch,
  ApiProblem,
  ApiTransportError,
  API_BASE_URL,
  PROBLEM_CONTENT_TYPE,
  REQUEST_ID_HEADER,
} from '@/lib/api';
import { jsonResponse, stubFetch } from '@/test/utils';

const problemBody = {
  type: 'https://vfm.io/problems/forbidden',
  title: 'Forbidden',
  status: 403,
  detail: 'restore:create is required on cluster vfm-a',
  instance: '/api/v1/clusters/vfm-a/restores',
  requestId: 'server-side-id',
};

describe('api client', () => {
  it('sends relative, credentialed requests against the configured base URL', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ items: [] }));

    await apiFetch('/clusters');

    expect(API_BASE_URL).toBe('/api/v1');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/v1/clusters');
    expect(init?.credentials).toBe('include');
  });

  it('mints a request id when the caller does not supply one', async () => {
    const fetchMock = stubFetch(() => jsonResponse({}));

    await apiFetch('/clusters');

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    // Matches the server's accepted inbound id shape (server/src/common/request-id.ts).
    expect(headers.get(REQUEST_ID_HEADER) ?? '').toMatch(/^[A-Za-z0-9._-]{8,128}$/);
  });

  it('passes a caller-supplied request id through unchanged', async () => {
    const fetchMock = stubFetch(() => jsonResponse({}));

    await apiFetch('/clusters', { requestId: 'trace-from-the-ui' });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get(REQUEST_ID_HEADER)).toBe('trace-from-the-ui');
  });

  it('parses application/problem+json into ApiProblem (RFC 9457)', async () => {
    stubFetch(() => jsonResponse(problemBody, { status: 403, contentType: PROBLEM_CONTENT_TYPE }));

    const error = await apiFetch('/clusters/vfm-a/restores', { method: 'POST', body: {} }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiProblem);
    const problem = error as ApiProblem;
    expect(problem.status).toBe(403);
    expect(problem.type).toBe(problemBody.type);
    expect(problem.title).toBe('Forbidden');
    expect(problem.detail).toBe(problemBody.detail);
    expect(problem.instance).toBe(problemBody.instance);
    // The id inside the document wins: it is the one the server logged.
    expect(problem.requestId).toBe('server-side-id');
    expect(problem.userMessage).toBe(`Forbidden: ${problemBody.detail}`);
  });

  it('prefers the response request id when the body carries none', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ title: 'Teapot', status: 418 }), {
          status: 418,
          headers: { 'Content-Type': PROBLEM_CONTENT_TYPE, [REQUEST_ID_HEADER]: 'from-header' },
        }),
    );

    await expect(apiFetch('/clusters')).rejects.toMatchObject({
      name: 'ApiProblem',
      requestId: 'from-header',
    });
  });

  it('still produces an ApiProblem when the error body is not a problem document', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const error = await apiFetch('/clusters').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiProblem);
    // The status line is authoritative; a reverse proxy's HTML page is not.
    expect((error as ApiProblem).status).toBe(502);
    expect((error as ApiProblem).title).not.toBe('');
  });

  it('reports a transport failure as ApiTransportError, not a problem', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    const error = await apiFetch('/clusters').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiTransportError);
    expect((error as ApiTransportError).timedOut).toBe(false);
  });

  it('times out instead of hanging forever', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );

    const error = await apiFetch('/clusters', { timeoutMs: 5 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiTransportError);
    expect((error as ApiTransportError).timedOut).toBe(true);
  });

  it('returns undefined for an empty body', async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    await expect(
      apiFetch<undefined>('/clusters/vfm-a', { method: 'DELETE' }),
    ).resolves.toBeUndefined();
  });

  it('refuses an absolute URL, which the CSP would block anyway (PLAN.md §1.1 P6)', async () => {
    stubFetch(() => jsonResponse({}));

    await expect(apiFetch('https://example.com/clusters')).rejects.toThrow(/must be relative/);
  });
});
