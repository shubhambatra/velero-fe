import { createHash } from 'node:crypto';

import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { createTestApp, type TestApp } from './app-harness';

/**
 * End-to-end coverage of M1 day 7 — per-org OIDC — against the dev stack's
 * real PostgreSQL, Redis **and Dex** (`make dev-up`, port 55556).
 *
 * Dex is driven the way a browser would be: follow the redirects, submit the
 * login form where there is one, and stop at the callback URL.
 */
const DEX = 'http://localhost:55556';
const ISSUER = `${DEX}/dex`;
const CLIENT_ID = 'vfm-control-plane';
const CLIENT_SECRET = 'vfm-dev-oidc-client-secret';
const PASSWORD = 'canopy-vellum-ratchet-82';
const CALLBACK_PATH = '/api/v1/auth/oidc/callback';

describe('oidc (e2e, against Dex)', () => {
  let harness: TestApp;
  let sessions: SessionService;

  beforeAll(async () => {
    harness = await createTestApp();
    sessions = harness.app.get(SessionService);
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  const api = (): request.Agent => harness.api();

  interface Actor {
    userId: string;
    call: (
      method: 'get' | 'post' | 'patch' | 'put' | 'delete',
      path: string,
      body?: object,
    ) => request.Test;
  }

  async function actAs(userId: string): Promise<Actor> {
    const created = await sessions.create({ userId, ip: '127.0.0.1', userAgent: 'vitest' });
    const cookie = `${SessionService.COOKIE}=${created.id}; ${SessionService.CSRF_COOKIE}=${created.csrfToken}`;
    return {
      userId,
      call: (method, path, body) => {
        const req = api()
          [method](`/api/v1${path}`)
          .set('Cookie', cookie)
          .set(CSRF_HEADER, created.csrfToken);
        return body === undefined ? req : req.send(body);
      },
    };
  }

  async function platformAdmin(): Promise<Actor> {
    const token = 'setup-' + Math.random().toString(36).slice(2);
    await harness.redis.connection.set(
      'vfm:setup:token',
      createHash('sha256').update(token, 'utf8').digest('hex'),
      'EX',
      3_600,
    );
    const res = await api()
      .post('/api/v1/auth/setup')
      .send({ token, email: 'root@vfm.local', password: PASSWORD })
      .expect(201);
    return actAs((res.body as { user: { id: string } }).user.id);
  }

  async function addMember(owner: Actor, orgId: string, email: string): Promise<Actor> {
    await owner.call('post', `/orgs/${orgId}/invites`, { email, orgRole: 'MEMBER' }).expect(201);
    const res = await api()
      .post('/api/v1/invites/register')
      .send({ token: harness.mail.tokenFor(email), password: PASSWORD })
      .expect(201);
    return actAs((res.body as { user: { id: string } }).user.id);
  }

  interface Fixture {
    admin: Actor;
    orgId: string;
    providerId: string;
    teamId: string;
  }

  async function fixture(
    provider: Record<string, unknown> = {},
    mapGroup: string | null = 'authors',
  ): Promise<Fixture> {
    const admin = await platformAdmin();
    const org = await admin.call('post', '/orgs', { name: 'Acme', slug: 'acme' }).expect(201);
    const orgId = (org.body as { id: string }).id;
    const team = await admin.call('post', `/orgs/${orgId}/teams`, { name: 'writers' }).expect(201);
    const teamId = (team.body as { id: string }).id;
    const res = await admin
      .call('post', `/orgs/${orgId}/oidc-providers`, {
        name: 'Dex',
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        groupClaim: 'groups',
        jitEnabled: true,
        mappings: mapGroup === null ? [] : [{ group: mapGroup, teamId }],
        ...provider,
      })
      .expect(201);
    return { admin, orgId, teamId, providerId: (res.body as { id: string }).id };
  }

  /** `Set-Cookie` headers → a `Cookie` request header. */
  const cookieHeader = (setCookie: string[]): string =>
    setCookie.map((c) => c.split(';')[0] ?? '').join('; ');

  interface Started {
    authUrl: string;
    cookies: string;
    state: string;
  }

  async function start(providerId: string): Promise<Started> {
    const res = await api().get(`/api/v1/auth/oidc/${providerId}/start`).expect(302);
    const authUrl = res.get('Location') ?? '';
    return {
      authUrl,
      cookies: cookieHeader(res.get('Set-Cookie') ?? []),
      state: new URL(authUrl).searchParams.get('state') ?? '',
    };
  }

  /**
   * Plays the browser against Dex until it would be sent back to us, and
   * returns that callback URL.
   */
  async function dexLogin(
    authUrl: string,
    connector: 'mock' | 'local',
    credentials?: { email: string; password: string },
  ): Promise<URL> {
    const first = new URL(authUrl);
    first.searchParams.set('connector_id', connector);
    let url = first.href;

    for (let hop = 0; hop < 12; hop += 1) {
      if (url.startsWith(`http://localhost:3000${CALLBACK_PATH}`)) {
        return new URL(url);
      }
      const res = await fetch(url, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (location !== null) {
        url = new URL(location, url).href;
        continue;
      }
      if (res.status === 200 && credentials !== undefined) {
        // The password connector's login form posts back to itself.
        const form = new URLSearchParams({
          login: credentials.email,
          password: credentials.password,
        });
        const post = await fetch(url, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form,
        });
        const next = post.headers.get('location');
        if (next === null) {
          throw new Error(`dex login form did not redirect (HTTP ${post.status.toString()})`);
        }
        url = new URL(next, url).href;
        continue;
      }
      throw new Error(`dex flow stalled at ${url} (HTTP ${res.status.toString()})`);
    }
    throw new Error('dex flow did not reach the callback');
  }

  /** Delivers a callback to the control plane as the browser would. */
  function deliver(callback: URL, cookies: string): request.Test {
    return api().get(`${CALLBACK_PATH}${callback.search}`).set('Cookie', cookies);
  }

  async function signInWithMock(f: Fixture): Promise<{ res: request.Response; cookies: string }> {
    const s = await start(f.providerId);
    const cb = await dexLogin(s.authUrl, 'mock');
    const res = await deliver(cb, s.cookies);
    return { res, cookies: s.cookies };
  }

  const isFailure = (res: request.Response): boolean =>
    res.status === 302 && (res.get('Location') ?? '').includes('sso=failed');

  const sessionCookie = (res: request.Response): string | undefined =>
    (res.get('Set-Cookie') ?? []).find((c) => c.startsWith(`${SessionService.COOKIE}=`));

  describe('starting a login', () => {
    it('redirects to the IdP with state, nonce and an S256 challenge', async () => {
      const f = await fixture();
      const s = await start(f.providerId);
      const url = new URL(s.authUrl);

      expect(url.origin).toBe(DEX);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
      expect(url.searchParams.get('nonce')).toMatch(/^[\w-]{40,}$/);
      expect(url.searchParams.get('scope')).toContain('groups');
      expect(s.state.length).toBeGreaterThanOrEqual(40);
      expect(s.cookies).toContain('vfm_oidc_state=');
    });

    it('answers 404 for an unknown or disabled provider', async () => {
      const f = await fixture();
      await api().get('/api/v1/auth/oidc/0192f2a0-0000-7000-8000-0000000000ff/start').expect(404);

      await f.admin
        .call('patch', `/orgs/${f.orgId}/oidc-providers/${f.providerId}`, { enabled: false })
        .expect(200);
      await api().get(`/api/v1/auth/oidc/${f.providerId}/start`).expect(404);
    });

    it('lists only enabled providers, by org slug, without secrets', async () => {
      const f = await fixture();
      const res = await api().get('/api/v1/auth/oidc/providers?org=acme').expect(200);
      expect(res.body).toEqual({ providers: [{ id: f.providerId, name: 'Dex' }] });
    });
  });

  describe('completing a login', () => {
    it('provisions a user, seats them in the org and the mapped team, and signs them in', async () => {
      const f = await fixture();
      const { res } = await signInWithMock(f);

      expect(res.status).toBe(302);
      expect(res.get('Location')).toMatch(/^http:\/\/localhost:5173\/(\?|$)/);
      const cookie = sessionCookie(res);
      expect(cookie).toBeDefined();

      const user = await harness.prisma.user.findUniqueOrThrow({
        where: { email: 'kilgore@kilgore.trout' },
      });
      // An OIDC-only account has no password at all.
      expect(user.passwordHash).toBeNull();

      const members = await f.admin.call('get', `/orgs/${f.orgId}/members`).expect(200);
      expect(JSON.stringify(members.body)).toContain('kilgore@kilgore.trout');
      const team = await f.admin
        .call('get', `/orgs/${f.orgId}/teams/${f.teamId}/members`)
        .expect(200);
      expect(JSON.stringify(team.body)).toContain('kilgore@kilgore.trout');

      // The session works: the user sees the org they were provisioned into.
      const orgs = await api()
        .get('/api/v1/me/orgs')
        .set('Cookie', cookieHeader(res.get('Set-Cookie') ?? []))
        .expect(200);
      expect((orgs.body as { orgs: unknown[] }).orgs).toHaveLength(1);
    });

    it('signs the same person into the same account next time', async () => {
      const f = await fixture();
      await signInWithMock(f);
      const second = await signInWithMock(f);

      expect(sessionCookie(second.res)).toBeDefined();
      const count = await harness.prisma.user.count({ where: { email: 'kilgore@kilgore.trout' } });
      expect(count).toBe(1);
      const identities = await harness.prisma.unscoped('test: count identities', () =>
        harness.prisma.oidcIdentity.count(),
      );
      expect(identities).toBe(1);
    });

    it('refuses an unknown user when JIT is off, and creates nothing', async () => {
      const f = await fixture({ jitEnabled: false });
      const { res } = await signInWithMock(f);

      expect(isFailure(res)).toBe(true);
      expect(sessionCookie(res)).toBeUndefined();
      expect(await harness.prisma.user.count({ where: { email: 'kilgore@kilgore.trout' } })).toBe(
        0,
      );
    });

    it('refuses a replayed callback', async () => {
      const f = await fixture();
      const s = await start(f.providerId);
      const cb = await dexLogin(s.authUrl, 'mock');

      const first = await deliver(cb, s.cookies);
      expect(sessionCookie(first)).toBeDefined();

      const replay = await deliver(cb, s.cookies);
      expect(isFailure(replay)).toBe(true);
      expect(sessionCookie(replay)).toBeUndefined();
    });

    it('refuses a callback from a browser that did not start the login (login CSRF)', async () => {
      const f = await fixture();
      const s = await start(f.providerId);
      const cb = await dexLogin(s.authUrl, 'mock');

      // The attacker's authorization code, delivered to a victim's browser,
      // which holds no state cookie.
      const res = await deliver(cb, '');
      expect(isFailure(res)).toBe(true);
      expect(sessionCookie(res)).toBeUndefined();
      expect(await harness.prisma.user.count({ where: { email: 'kilgore@kilgore.trout' } })).toBe(
        0,
      );
    });

    it('refuses a callback whose state was tampered with', async () => {
      const f = await fixture();
      const s = await start(f.providerId);
      const cb = await dexLogin(s.authUrl, 'mock');
      cb.searchParams.set('state', `${s.state.slice(0, -1)}${s.state.endsWith('A') ? 'B' : 'A'}`);

      const res = await deliver(cb, s.cookies);
      expect(isFailure(res)).toBe(true);
    });

    it('refuses a code that was issued for a different login (PKCE and state)', async () => {
      const f = await fixture();
      const a = await start(f.providerId);
      const b = await start(f.providerId);
      const cbA = await dexLogin(a.authUrl, 'mock');

      // A's code, presented under B's state and cookie.
      const swapped = new URL(cbA.href);
      swapped.searchParams.set('state', b.state);
      const res = await deliver(swapped, b.cookies);

      expect(isFailure(res)).toBe(true);
      expect(sessionCookie(res)).toBeUndefined();
    });

    it('refuses an IdP error response', async () => {
      const f = await fixture();
      const s = await start(f.providerId);
      const res = await api()
        .get(`${CALLBACK_PATH}?error=access_denied&state=${s.state}`)
        .set('Cookie', s.cookies);
      expect(isFailure(res)).toBe(true);
    });

    it('does not let an OIDC-only account sign in with a password', async () => {
      const f = await fixture();
      await signInWithMock(f);

      await api()
        .post('/api/v1/auth/login')
        .send({ email: 'kilgore@kilgore.trout', password: PASSWORD })
        .expect(401);
      expect(f.orgId).toBeDefined();
    });
  });

  describe('linking to existing accounts', () => {
    const DEX_USER = { email: 'viewer@vfm.local', password: 'vfm-dev-password' };

    it('links by verified email when the account is already a member of the org', async () => {
      const f = await fixture({ jitEnabled: false });
      const existing = await addMember(f.admin, f.orgId, DEX_USER.email);

      const s = await start(f.providerId);
      const cb = await dexLogin(s.authUrl, 'local', DEX_USER);
      const res = await deliver(cb, s.cookies);

      expect(sessionCookie(res)).toBeDefined();
      const identity = await harness.prisma.unscoped('test: read identity', () =>
        harness.prisma.oidcIdentity.findFirstOrThrow(),
      );
      expect(identity.userId).toBe(existing.userId);
    });

    it('refuses to link an account that is not a member, even with JIT on', async () => {
      const f = await fixture({ jitEnabled: true });
      // The address belongs to an account in a *different* org.
      const other = await f.admin
        .call('post', '/orgs', { name: 'Other', slug: 'other' })
        .expect(201);
      await addMember(f.admin, (other.body as { id: string }).id, DEX_USER.email);

      const s = await start(f.providerId);
      const cb = await dexLogin(s.authUrl, 'local', DEX_USER);
      const res = await deliver(cb, s.cookies);

      expect(isFailure(res)).toBe(true);
      expect(sessionCookie(res)).toBeUndefined();
      const memberships = await f.admin.call('get', `/orgs/${f.orgId}/members`).expect(200);
      expect(JSON.stringify(memberships.body)).not.toContain(DEX_USER.email);
    });

    it('refuses a disabled account', async () => {
      const f = await fixture({ jitEnabled: false });
      const existing = await addMember(f.admin, f.orgId, DEX_USER.email);
      await harness.prisma.user.update({
        where: { id: existing.userId },
        data: { disabledAt: new Date() },
      });

      const s = await start(f.providerId);
      const cb = await dexLogin(s.authUrl, 'local', DEX_USER);
      const res = await deliver(cb, s.cookies);
      expect(isFailure(res)).toBe(true);
    });
  });

  describe('group to team mapping', () => {
    it('moves the user when the mapping stops matching, and leaves manual teams alone', async () => {
      const f = await fixture();
      const manual = await f.admin
        .call('post', `/orgs/${f.orgId}/teams`, { name: 'hand-managed' })
        .expect(201);
      const manualId = (manual.body as { id: string }).id;

      const first = await signInWithMock(f);
      expect(sessionCookie(first.res)).toBeDefined();
      const user = await harness.prisma.user.findUniqueOrThrow({
        where: { email: 'kilgore@kilgore.trout' },
      });
      await f.admin
        .call('put', `/orgs/${f.orgId}/teams/${manualId}/members/${user.id}`)
        .expect(204);

      // The IdP's group is renamed from the mapping's point of view.
      await f.admin
        .call('patch', `/orgs/${f.orgId}/oidc-providers/${f.providerId}`, {
          mappings: [{ group: 'editors', teamId: f.teamId }],
        })
        .expect(200);
      await signInWithMock(f);

      const writers = await f.admin
        .call('get', `/orgs/${f.orgId}/teams/${f.teamId}/members`)
        .expect(200);
      expect(JSON.stringify(writers.body)).not.toContain('kilgore@kilgore.trout');
      const hand = await f.admin
        .call('get', `/orgs/${f.orgId}/teams/${manualId}/members`)
        .expect(200);
      expect(JSON.stringify(hand.body)).toContain('kilgore@kilgore.trout');
    });
  });

  describe('administration', () => {
    it('never returns the client secret, and stores it encrypted', async () => {
      const f = await fixture();
      const list = await f.admin.call('get', `/orgs/${f.orgId}/oidc-providers`).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(CLIENT_SECRET);

      const row = await harness.prisma.unscoped('test: read raw provider', () =>
        harness.prisma.oidcProvider.findUniqueOrThrow({ where: { id: f.providerId } }),
      );
      expect(row.clientSecretEncrypted).not.toContain(CLIENT_SECRET);
      expect(row.clientSecretEncrypted.length).toBeGreaterThan(CLIENT_SECRET.length);
    });

    it('is closed to plain members and to other orgs', async () => {
      const f = await fixture();
      const member = await addMember(f.admin, f.orgId, 'm@acme.test');
      await member.call('get', `/orgs/${f.orgId}/oidc-providers`).expect(403);
      await member.call('post', `/orgs/${f.orgId}/oidc-providers`, {}).expect(403);

      const other = await f.admin
        .call('post', '/orgs', { name: 'Other', slug: 'other' })
        .expect(201);
      const otherId = (other.body as { id: string }).id;
      // Same platform admin, but a provider id from another org is not theirs
      // to touch through this org's path.
      await f.admin
        .call('patch', `/orgs/${otherId}/oidc-providers/${f.providerId}`, { name: 'x' })
        .expect(404);
    });

    it('refuses a mapping to a team in another org', async () => {
      const f = await fixture();
      const other = await f.admin
        .call('post', '/orgs', { name: 'Other', slug: 'other' })
        .expect(201);
      const foreignTeam = await f.admin
        .call('post', `/orgs/${(other.body as { id: string }).id}/teams`, { name: 'foreign' })
        .expect(201);

      await f.admin
        .call('patch', `/orgs/${f.orgId}/oidc-providers/${f.providerId}`, {
          mappings: [{ group: 'authors', teamId: (foreignTeam.body as { id: string }).id }],
        })
        .expect(400);
    });

    it('will not change the issuer once users are linked', async () => {
      const f = await fixture();
      await signInWithMock(f);
      await f.admin
        .call('patch', `/orgs/${f.orgId}/oidc-providers/${f.providerId}`, {
          issuer: 'http://localhost:9/other',
        })
        .expect(400);
    });
  });
});
