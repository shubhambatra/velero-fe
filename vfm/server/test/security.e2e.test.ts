/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/restrict-template-expressions -- response bodies are untyped JSON on purpose */
import 'reflect-metadata';

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env.schema';
import { createTestApp, type TestApp } from './app-harness';
import { World } from './world';

/**
 * M7 day 36: the mitigations of docs/THREAT_MODEL.md that no feature test already pins:
 * the headers the browser is told to enforce, the body cap, and where the control plane is
 * willing to connect on an administrator's say-so.
 */
describe('security (e2e)', () => {
  let h: TestApp;
  let world: World;
  let env: Env;

  beforeAll(async () => {
    h = await createTestApp();
    world = new World(h);
    await world.init();
    env = h.app.get<Env>(ENV);
  }, 60_000);

  afterAll(async () => {
    world.close();
    await h.close();
  });

  beforeEach(async () => {
    await h.reset();
    env.OIDC_ALLOW_PRIVATE = true;
    env.OIDC_ALLOW_HTTP = true;
  });

  describe('what every response tells the browser', () => {
    const csp = async (path: string) =>
      (await h.api().get(path)).headers['content-security-policy'] as string;

    it.each(['/healthz', '/api/v1/auth/me', '/api/v1/no-such-route'])(
      'sends a strict policy on %s',
      async (path) => {
        const policy = await csp(path);
        const directives = Object.fromEntries(
          policy.split(';').map((d) => {
            const [name, ...values] = d.trim().split(/\s+/);
            return [name, values];
          }),
        );
        expect(directives['default-src']).toEqual(["'none'"]);
        expect(directives['script-src']).toEqual(["'self'"]);
        expect(directives['style-src']).toEqual(["'self'"]);
        expect(directives['connect-src']).toEqual(["'self'"]);
        expect(directives['frame-ancestors']).toEqual(["'none'"]);
        expect(directives['base-uri']).toEqual(["'none'"]);
        expect(directives['object-src']).toEqual(["'none'"]);
        expect(directives['form-action']).toEqual(["'self'"]);
        // Nothing that would let injected script run or load from elsewhere.
        expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
      },
    );

    it('forbids framing, sniffing and leaking the address, and does not name the framework', async () => {
      const res = await h.api().get('/api/v1/auth/me');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
      // No CORS: the browser only ever talks to its own origin.
      const cross = await h.api().get('/api/v1/auth/me').set('Origin', 'https://evil.example');
      expect(cross.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers a refused request without a stack trace or an internal path', async () => {
      const res = await h.api().get('/api/v1/auth/me').expect(401);
      expect(JSON.stringify(res.body)).not.toMatch(/\bat \w+.*\(|node_modules|\/home\/|\.ts:\d+/);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    });
  });

  describe('request size', () => {
    it('refuses a JSON body over 1 MB before reading it into the application', async () => {
      const big = { email: 'a@b.co', password: 'x'.repeat(2 * 1024 * 1024) };
      const res = await h.api().post('/api/v1/auth/login').send(big);
      expect(res.status).toBe(413);
    });

    it('answers malformed JSON with 400 and a fixed sentence, not a 500 and not the body', async () => {
      const res = await h
        .api()
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email": "a@b.co", "password": "TOPSECRET-fragment"');
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('TOPSECRET');
      expect(res.body.detail).toBe('The request body is not valid JSON.');
    });

    it('accepts one just under', async () => {
      const res = await h
        .api()
        .post('/api/v1/auth/login')
        .send({ email: 'a@b.co', password: 'x'.repeat(900 * 1024) });
      expect(res.status).not.toBe(413);
    });
  });

  describe('where an identity provider may be', () => {
    let hits: number;
    let idp: http.Server;
    let base: string;

    beforeAll(async () => {
      idp = http.createServer((_req, res) => {
        hits += 1;
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      idp.close();
    });
    beforeEach(() => {
      hits = 0;
    });

    const create = async (issuer: string) => {
      const { call, orgId } = await world.admin();
      const res = await call('post', `/orgs/${orgId}/oidc-providers`, {
        name: 'idp',
        issuer,
        clientId: 'c',
        clientSecret: 's',
      });
      return { res, call, orgId };
    };

    it('refuses an issuer on a private network, in plain http, or with credentials, unless the operator allowed it', async () => {
      env.OIDC_ALLOW_PRIVATE = false;
      env.OIDC_ALLOW_HTTP = false;
      for (const issuer of [
        'http://idp.example.com',
        'https://10.0.0.5',
        'https://127.0.0.1',
        'https://localhost',
        'https://[::1]',
        'https://user:pw@idp.example.com',
        'https://169.254.169.254/latest',
      ]) {
        const { res } = await create(issuer);
        expect(res.status, issuer).toBe(400);
        expect(JSON.stringify(res.body), issuer).toMatch(/issuer:/);
        await h.reset();
      }
      expect((await create('https://idp.example.com')).res.status).toBe(201);
    });

    it('never accepts the metadata address, even when private networks are allowed', async () => {
      const { res } = await create('http://169.254.169.254/latest');
      expect(res.status).toBe(400);
    });

    it('answers 502, not a crash, when a registered provider cannot be reached, and says nothing of where it tried', async () => {
      const { res } = await create('https://idp.invalid');
      expect(res.status).toBe(201);
      const started = await h.api().get(`/api/v1/auth/oidc/${res.body.id}/start`);
      expect(started.status).toBe(502);
      expect(JSON.stringify(started.body)).not.toContain('idp.invalid');
      expect(started.body.detail).toBe('the identity provider could not be reached');
    });

    it('does not connect to a stored issuer once the operator has withdrawn the permission', async () => {
      const { res } = await create(base);
      expect(res.status).toBe(201);
      env.OIDC_ALLOW_PRIVATE = false;
      env.OIDC_ALLOW_HTTP = false;
      const started = await h.api().get(`/api/v1/auth/oidc/${res.body.id}/start`);
      expect(hits).toBe(0);
      expect(started.headers.location ?? '').not.toContain('127.0.0.1');
    });
  });

  describe('how often one caller may knock (threat model G-3)', () => {
    it('limits the routes anyone can call, per address, and says when to come back', async () => {
      const knock = () => h.api().get('/api/v1/auth/oidc/providers?org=nobody');
      for (let i = 0; i < 120; i += 1) {
        await knock().expect(200);
      }
      const refused = await knock().expect(429);
      expect(Number(refused.get('Retry-After'))).toBeGreaterThan(0);
      expect(Number(refused.get('Retry-After'))).toBeLessThanOrEqual(60);
      expect(refused.body.detail).toBe('too many requests; try again later');
      // Another route has its own budget.
      await h.api().get('/api/v1/auth/setup').expect(200);
    }, 60_000);

    it('limits first-run setup attempts, so the one-time token cannot be ground down', async () => {
      const attempt = () =>
        h
          .api()
          .post('/api/v1/auth/setup')
          .send({ token: 'wrong', email: 'a@b.co', password: 'canopy-vellum-ratchet-82' });
      for (let i = 0; i < 10; i += 1) {
        expect((await attempt()).status).not.toBe(429);
      }
      await attempt().expect(429);
    });

    it('counts a signed-in person as themselves, not as their address', async () => {
      const { call, orgId } = await world.admin();
      const report = () => call('get', `/orgs/${orgId}/reports/coverage`);
      for (let i = 0; i < 30; i += 1) {
        await report().expect(200);
      }
      const refused = await report().expect(429);
      expect(refused.get('Retry-After')).toBeDefined();
      // Someone else behind the same address is not affected.
      const other = await world.member(call, orgId, 'other@acme.test');
      await other.call('get', `/orgs/${orgId}/reports/coverage`).expect(200);
    }, 60_000);

    it('lets the budget start again when the window ends', async () => {
      const { call, orgId } = await world.admin();
      for (let i = 0; i < 31; i += 1) {
        await call('get', `/orgs/${orgId}/reports/coverage`);
      }
      await call('get', `/orgs/${orgId}/reports/coverage`).expect(429);
      const keys = await h.redis.connection.keys('vfm:rl:reports:*');
      expect(keys).toHaveLength(1);
      await h.redis.connection.del(...keys);
      await call('get', `/orgs/${orgId}/reports/coverage`).expect(200);
      // The counter has an expiry, so it cannot outlive its window.
      const again = await h.redis.connection.keys('vfm:rl:reports:*');
      expect(await h.redis.connection.ttl(again[0] as string)).toBeGreaterThan(0);
    }, 60_000);

    it('keeps working when the counter cannot be read', async () => {
      const { call, orgId } = await world.admin();
      const original = h.redis.connection.incr.bind(h.redis.connection);
      (h.redis.connection as any).incr = () => Promise.reject(new Error('redis down'));
      try {
        await call('get', `/orgs/${orgId}/reports/coverage`).expect(200);
      } finally {
        (h.redis.connection as any).incr = original;
      }
    });
  });
});
