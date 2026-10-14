import { describe, expect, it, vi } from 'vitest';

import { REQUEST_ID_HEADER, requestIdMiddleware } from './request-id';

interface FakeRequest {
  requestId?: string;
  header: (name: string) => string | undefined;
}

function run(inbound?: string): { req: FakeRequest; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const req: FakeRequest = {
    header: (name) => (name === REQUEST_ID_HEADER ? inbound : undefined),
  };
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  };
  const next = vi.fn();

  // The middleware is typed against Express; the fakes carry exactly the
  // surface it touches.
  requestIdMiddleware(
    req as unknown as Parameters<typeof requestIdMiddleware>[0],
    res as unknown as Parameters<typeof requestIdMiddleware>[1],
    next,
  );

  expect(next).toHaveBeenCalledOnce();
  return { req, headers };
}

describe('requestIdMiddleware', () => {
  it('generates an id when the client sends none', () => {
    const { req, headers } = run();

    expect(req.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(headers[REQUEST_ID_HEADER]).toBe(req.requestId);
  });

  it('reuses a well-formed inbound id so a trace survives a proxy', () => {
    const { req, headers } = run('edge-7f3a9c21');

    expect(req.requestId).toBe('edge-7f3a9c21');
    expect(headers[REQUEST_ID_HEADER]).toBe('edge-7f3a9c21');
  });

  it('replaces an inbound id that could inject content into logs and audit rows', () => {
    // The id is echoed into error bodies and written to audit events, so an
    // attacker must not control its content (PLAN.md §12.1).
    for (const hostile of [
      '<script>alert(1)</script>',
      'a'.repeat(5000),
      'short',
      'has spaces',
      'line\nbreak',
      'semi;colon',
    ]) {
      const { req } = run(hostile);
      expect(req.requestId, hostile).not.toBe(hostile);
      expect(req.requestId).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    }
  });

  it('always sets the response header', () => {
    expect(run().headers[REQUEST_ID_HEADER]).toBeDefined();
    expect(run('edge-7f3a9c21').headers[REQUEST_ID_HEADER]).toBeDefined();
  });
});
