import { afterEach, describe, expect, it } from 'vitest';

import { ApiProblem } from '@/lib/api';
import { api, readCsrfToken, registerSudoPrompt } from '@/lib/client';
import { jsonResponse, stubFetch } from '@/test/utils';

const PROBLEM = 'application/problem+json';

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe('session-aware api client', () => {
  afterEach(() => {
    document.cookie = 'vfm_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('sends the CSRF cookie value on non-GET requests only', async () => {
    document.cookie = 'vfm_csrf=tok%2F123; path=/';
    const fetchMock = stubFetch(() => jsonResponse({}));

    await api('/things');
    await api('/things', { method: 'POST', body: { a: 1 } });

    expect(readCsrfToken()).toBe('tok/123');
    expect(headersOf(fetchMock.mock.calls[0]?.[1]).get('x-csrf-token')).toBeNull();
    expect(headersOf(fetchMock.mock.calls[1]?.[1]).get('x-csrf-token')).toBe('tok/123');
  });

  it('parses problem+json including the 403 flags', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          type: 'x',
          title: 'Forbidden',
          status: 403,
          detail: 'second factor needed',
          mfaRequired: true,
          mfaPendingReason: 'challenge',
        },
        { status: 403, contentType: PROBLEM },
      ),
    );

    const error = await api('/auth/me').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiProblem);
    const problem = error as ApiProblem;
    expect(problem.status).toBe(403);
    expect(problem.detail).toBe('second factor needed');
    expect(problem.mfaRequired).toBe(true);
    expect(problem.mfaPendingReason).toBe('challenge');
    expect(problem.sudoRequired).toBe(false);
  });

  it('prompts for sudo and retries exactly once', async () => {
    let calls = 0;
    const fetchMock = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse(
            { title: 'Forbidden', status: 403, sudoRequired: true },
            { status: 403, contentType: PROBLEM },
          )
        : jsonResponse({ ok: true });
    });
    const unregister = registerSudoPrompt(() => Promise.resolve(true));

    const result = await api<{ ok: boolean }>('/orgs/o/teams/t', { method: 'DELETE' });
    unregister();

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the user declines, and surfaces the original error', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(
        { title: 'Forbidden', status: 403, sudoRequired: true },
        { status: 403, contentType: PROBLEM },
      ),
    );
    const unregister = registerSudoPrompt(() => Promise.resolve(false));

    await expect(api('/x', { method: 'DELETE' })).rejects.toBeInstanceOf(ApiProblem);
    unregister();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry if the server still asks for sudo', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse(
        { title: 'Forbidden', status: 403, sudoRequired: true },
        { status: 403, contentType: PROBLEM },
      ),
    );
    const unregister = registerSudoPrompt(() => Promise.resolve(true));

    await expect(api('/x', { method: 'DELETE' })).rejects.toBeInstanceOf(ApiProblem);
    unregister();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
