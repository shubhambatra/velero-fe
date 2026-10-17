import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './app-harness';

/** The request log line is a documented contract (docs/OBSERVABILITY.md): these fields, and no secrets. */
describe('log fields (e2e)', () => {
  let harness: TestApp;
  const lines: string[] = [];

  beforeAll(async () => {
    harness = await createTestApp({ logTo: (l) => lines.push(l) });
  }, 60_000);
  afterAll(async () => {
    await harness.close();
  });

  it('writes one structured line per request, with the request id and no query string or credentials', async () => {
    lines.length = 0;
    await harness
      .api()
      .get('/api/v1/auth/oidc/callback?code=SECRET-ONE-TIME-CODE&state=SECRET-STATE')
      .set('Authorization', 'Bearer secret-token-value')
      .set('Cookie', 'vfm_session=secret-session')
      .set('X-Request-Id', 'req-12345678');
    await new Promise((r) => setTimeout(r, 200));

    const mine = lines.filter((l) => l.includes('req-12345678'));
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const text = mine.join('\n');
    for (const secret of [
      'SECRET-ONE-TIME-CODE',
      'SECRET-STATE',
      'secret-token-value',
      'secret-session',
    ]) {
      expect(text, secret).not.toContain(secret);
    }

    const entry = JSON.parse(mine.find((l) => l.includes('"res"')) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(Object.keys(entry).sort()).toEqual(
      [
        'hostname',
        'level',
        'msg',
        'pid',
        'req',
        'requestIdHeader',
        'res',
        'responseTime',
        'time',
      ].sort(),
    );
    const req = entry.req as Record<string, unknown>;
    expect(req.id).toBe('req-12345678');
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/auth/oidc/callback');
    expect(Object.keys(req).sort()).toEqual(
      ['id', 'method', 'remoteAddress', 'url', 'userAgent'].filter((k) => k in req).sort(),
    );
    expect(typeof (entry.res as { statusCode: unknown }).statusCode).toBe('number');
    expect(typeof entry.responseTime).toBe('number');
  });
});
