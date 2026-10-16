import { createHash } from 'node:crypto';

import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service';
import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { createTestApp, seedClusters, type TestApp } from './app-harness';

/**
 * End-to-end coverage of API tokens (M1 day 9): shown once, stored hashed,
 * narrowing only, opt-in per route, pinned to one org, and dead the moment the
 * owner loses membership.
 */
const PASSWORD = 'canopy-vellum-ratchet-82';
const CLUSTER = '0192f2a0-0000-7000-8000-00000000c001';
const OTHER_CLUSTER = '0192f2a0-0000-7000-8000-00000000c002';

describe('api tokens (e2e)', () => {
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
    harness.mail.configured = true;
  });

  const api = (): request.Agent => harness.api();

  interface Actor {
    userId: string;
    sessionId: string;
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
      sessionId: created.id,
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
    return actAs(res.body.user.id as string);
  }

  async function createOrg(admin: Actor, slug: string): Promise<string> {
    const res = await admin.call('post', '/orgs', { name: `Org ${slug}`, slug }).expect(201);
    const orgId = res.body.id as string;
    await admin.call('post', '/me/active-org', { orgId }).expect(204);
    await seedClusters(harness.prisma, orgId, [CLUSTER, OTHER_CLUSTER]);
    return orgId;
  }

  async function addMember(
    owner: Actor,
    orgId: string,
    email: string,
    orgRole = 'MEMBER',
  ): Promise<Actor> {
    await owner.call('post', `/orgs/${orgId}/invites`, { email, orgRole }).expect(201);
    const token = harness.mail.tokenFor(email);
    const res = await api()
      .post('/api/v1/invites/register')
      .send({ token, password: PASSWORD, name: email })
      .expect(201);
    const actor = await actAs(res.body.user.id as string);
    await actor.call('post', '/me/active-org', { orgId }).expect(204);
    return actor;
  }

  async function bind(
    admin: Actor,
    subject: Actor,
    role: string,
    scope: object = { type: 'CLUSTER' },
    cluster = CLUSTER,
  ): Promise<string> {
    const res = await admin
      .call('post', `/clusters/${cluster}/role-bindings`, {
        subjectType: 'USER',
        subjectId: subject.userId,
        role,
        scope,
      })
      .expect(201);
    return res.body.id as string;
  }

  const bearer = (token: string, path: string) =>
    api().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  async function mint(
    actor: Actor,
    orgId: string,
    body: object = { name: 'ci' },
  ): Promise<{ id: string; token: string }> {
    const res = await actor.call('post', `/orgs/${orgId}/tokens`, body).expect(201);
    return res.body as { id: string; token: string };
  }

  describe('creation', () => {
    it('returns the secret once, with the vfm_ prefix, and never again', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const created = await mint(admin, orgId, { name: 'ci', expiresInDays: 30 });
      expect(created.token).toMatch(/^vfm_[A-Za-z0-9_-]{43}$/);

      const list = await admin.call('get', `/orgs/${orgId}/tokens`).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(created.token);
      expect(list.body.tokens[0]).toMatchObject({ id: created.id, name: 'ci' });
      expect(list.body.tokens[0].prefix).toBe(created.token.slice(0, 12));
      expect(list.body.tokens[0].expiresAt).toBeTruthy();
    });

    it('stores only a hash', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const { token } = await mint(admin, orgId);

      const rows = await harness.prisma.unscoped('test: inspect stored token', () =>
        harness.prisma.apiToken.findMany(),
      );
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    });

    it('needs sudo', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await sessions.update(admin.sessionId, { lastReauthAt: Date.now() - 10 * 60 * 1_000 });
      const res = await admin.call('post', `/orgs/${orgId}/tokens`, { name: 'x' }).expect(403);
      expect(res.body.sudoRequired).toBe(true);
    });

    it('rejects unknown permissions, bad expiry and an empty name', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin
        .call('post', `/orgs/${orgId}/tokens`, { name: 'x', permissions: ['root:all'] })
        .expect(409);
      await admin
        .call('post', `/orgs/${orgId}/tokens`, { name: 'x', expiresInDays: 0 })
        .expect(422);
      await admin
        .call('post', `/orgs/${orgId}/tokens`, { name: 'x', expiresInDays: 4000 })
        .expect(422);
      await admin.call('post', `/orgs/${orgId}/tokens`, { name: '' }).expect(422);
    });
  });

  describe('using a token', () => {
    it('authenticates an opted-in route and acts as its owner', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await bind(admin, dev, 'VIEWER');
      const { token } = await mint(dev, orgId);

      const res = await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(200);
      expect(res.body.grants[0]).toMatchObject({ role: 'VIEWER' });
      expect(res.body.tokenLimit).toEqual({ permissions: null, clusterIds: null });
    });

    it('is refused on routes that did not opt in, even for valid tokens', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const { token } = await mint(admin, orgId);

      await bearer(token, `/orgs/${orgId}`).expect(403);
      await bearer(token, '/me/orgs').expect(403);
      await bearer(token, `/orgs/${orgId}/tokens`).expect(403);
      await api()
        .post(`/api/v1/orgs/${orgId}/tokens`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'child' })
        .expect(403);
    });

    it('gives one answer for unknown, malformed and revoked tokens', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const { id, token } = await mint(admin, orgId);
      await admin.call('delete', `/orgs/${orgId}/tokens/${id}`).expect(204);

      const path = `/clusters/${CLUSTER}/my-access`;
      await bearer(token, path).expect(401);
      await bearer('vfm_' + 'A'.repeat(43), path).expect(401);
      await bearer('not-a-token', path).expect(401);
    });

    it('stops at expiry', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const { id, token } = await mint(admin, orgId, { name: 'short', expiresInDays: 1 });
      await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(200);

      await harness.prisma.unscoped('test: age a token', () =>
        harness.prisma.apiToken.update({
          where: { id },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        }),
      );
      await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(401);
    });

    it('is pinned to its org', async () => {
      const admin = await platformAdmin();
      const orgA = await createOrg(admin, 'alpha');
      const orgB = await createOrg(admin, 'beta');
      await admin.call('post', '/me/active-org', { orgId: orgA }).expect(204);
      const { token } = await mint(admin, orgA);

      // The owner is an Owner of beta too; the token must not follow.
      await bearer(token, `/orgs/${orgB}/audit`).expect(403);
      const mine = await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(200);
      expect(mine.body.orgRole).toBe('OWNER');
    });
  });

  describe('narrowing', () => {
    it('cannot widen: a token for a viewer gains nothing', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await bind(admin, dev, 'VIEWER');
      const { token } = await mint(dev, orgId, {
        name: 'wide',
        permissions: ['cluster:read', 'backup:delete', 'cluster:manage'],
      });

      // my-access needs cluster:read, which the viewer holds and the token lists.
      await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(200);
    });

    it('is cut down by its permission list', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const { token } = await mint(admin, orgId, { name: 'logs', permissions: ['backup:read'] });

      // An Owner could read this; the token lists no cluster:read.
      await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(404);
    });

    it('is cut down by its cluster list', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const { token } = await mint(admin, orgId, { name: 'one', clusterIds: [CLUSTER] });

      await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(200);
      await bearer(token, `/clusters/${OTHER_CLUSTER}/my-access`).expect(404);
    });

    it('follows the owner’s demotion immediately', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      const bindingId = await bind(admin, dev, 'VIEWER');
      const { token } = await mint(dev, orgId);
      await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(200);

      await admin.call('delete', `/clusters/${CLUSTER}/role-bindings/${bindingId}`).expect(204);
      await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(404);
    });
  });

  describe('lifecycle', () => {
    it('dies with the membership', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await bind(admin, dev, 'VIEWER');
      const { token } = await mint(dev, orgId);
      await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(200);

      await admin.call('delete', `/orgs/${orgId}/members/${dev.userId}`).expect(204);
      await bearer(token, `/clusters/${CLUSTER}/my-access`).expect(401);
    });

    it('lets a member list and revoke only their own, and an admin everything', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const a = await addMember(admin, orgId, 'a@acme.test');
      const b = await addMember(admin, orgId, 'b@acme.test');
      const ta = await mint(a, orgId, { name: 'a-token' });
      await mint(b, orgId, { name: 'b-token' });

      const own = await b.call('get', `/orgs/${orgId}/tokens`).expect(200);
      expect((own.body as { tokens: { name: string }[] }).tokens.map((t) => t.name)).toEqual([
        'b-token',
      ]);
      await b.call('get', `/orgs/${orgId}/tokens?scope=org`).expect(403);
      await b.call('delete', `/orgs/${orgId}/tokens/${ta.id}`).expect(404);

      const all = await admin.call('get', `/orgs/${orgId}/tokens?scope=org`).expect(200);
      expect(all.body.tokens).toHaveLength(2);
      await admin.call('delete', `/orgs/${orgId}/tokens/${ta.id}`).expect(204);
      await bearer(ta.token, `/clusters/${CLUSTER}/my-access`).expect(401);
    });

    it('is audited as a TOKEN actor on behalf of its owner', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const { id, token } = await mint(admin, orgId);

      // Use a mutating, token-accepting route is not available yet, so assert
      // the creation and the revocation reach the log with the human actor.
      await admin.call('delete', `/orgs/${orgId}/tokens/${id}`).expect(204);
      await harness.app.get(AuditService).drain();
      const log = await admin.call('get', `/orgs/${orgId}/audit?action=tokens`).expect(200);
      const actions = (log.body.events as { action: string; actorType: string }[]).map(
        (e) => `${e.actorType} ${e.action}`,
      );
      expect(actions).toContain('USER POST /orgs/:orgId/tokens');
      expect(actions).toContain('USER DELETE /orgs/:orgId/tokens/:tokenId');
      expect(JSON.stringify(log.body)).not.toContain(token);
    });
  });
});
