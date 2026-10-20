import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { isApiPath, mountWeb } from './web-static';

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vfm-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<html><body>app</body></html>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
  return dir;
}

function app(dir: string) {
  const a = express();
  const mounted = mountWeb(a, dir);
  // What the API would answer, to prove the fallback does not shadow it.
  a.get('/api/v1/ping', (_req, res) => res.json({ pong: true }));
  a.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  a.post('/api/v1/thing', (_req, res) => res.status(201).json({}));
  return { a, mounted };
}

describe('mountWeb', () => {
  it('does nothing when there is no built UI, so a server without one still starts', () => {
    const { mounted } = app(mkdtempSync(join(tmpdir(), 'vfm-empty-')));
    expect(mounted).toBe(false);
  });

  it('serves index.html at the root and for client-side routes, never cached', async () => {
    const { a } = app(site());
    for (const path of ['/', '/clusters/abc/backups', '/login']) {
      const res = await request(a).get(path).expect(200);
      expect(res.text).toContain('app');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves hashed assets with a year of caching and other files without', async () => {
    const { a } = app(site());
    const asset = await request(a).get('/assets/index-abc123.js').expect(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(a).get('/favicon.svg').expect(200)).headers['cache-control']).toBe(
      'no-cache',
    );
  });

  it('leaves the API and the probes to the API, including its 404s', async () => {
    const { a } = app(site());
    await request(a).get('/api/v1/ping').expect(200, { pong: true });
    await request(a).get('/healthz').expect(200, { status: 'ok' });
    await request(a).post('/api/v1/thing').expect(201);
    // An unknown API path is not the app: it must not come back as a 200 HTML page.
    const res = await request(a).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('app');
  });

  it('does not let a path climb out of the directory', async () => {
    const { a } = app(site());
    const res = await request(a).get('/assets/..%2f..%2f..%2fetc%2fpasswd');
    expect(res.text).not.toContain('root:');
  });

  it('knows which paths are the API', () => {
    expect(isApiPath('/api/v1/x')).toBe(true);
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/healthz')).toBe(true);
    expect(isApiPath('/readyz')).toBe(true);
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/clusters')).toBe(false);
  });
});
