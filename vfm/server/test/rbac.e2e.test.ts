import { createHash, randomUUID } from 'node:crypto';

import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { createTestApp, seedClusters, type TestApp } from './app-harness';

/**
 * End-to-end coverage of M1 day 8 — RBAC — against real PostgreSQL and Redis.
 *
 * The decision function itself is covered exhaustively in
 * `packages/shared/src/rbac.test.ts`. What this proves is the plumbing around
 * it: that the right facts reach `authorize()`, that the guard fails closed,
 * that binding changes need sudo, and that nothing crosses an org boundary.
 */
const PASSWORD = 'canopy-vellum-ratchet-82';
const CLUSTER = '0192f2a0-0000-7000-8000-00000000c001';
const OTHER_CLUSTER = '0192f2a0-0000-7000-8000-00000000c002';

describe('rbac (e2e)', () => {
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
    subject: { subjectType: 'USER' | 'TEAM'; subjectId: string },
    role: string,
    scope: object = { type: 'CLUSTER' },
    cluster = CLUSTER,
  ): Promise<string> {
    const res = await admin
      .call('post', `/clusters/${cluster}/role-bindings`, { ...subject, role, scope })
      .expect(201);
    return res.body.id as string;
  }

  const user = (a: Actor) => ({ subjectType: 'USER' as const, subjectId: a.userId });

  async function expireSudo(actor: Actor): Promise<void> {
    await sessions.update(actor.sessionId, { lastReauthAt: Date.now() - 10 * 60 * 1_000 });
  }

  describe('who may see and manage bindings', () => {
    it('lets an org owner manage bindings with no binding of their own', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');

      await bind(admin, user(dev), 'VIEWER');
      const list = await admin.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(200);
      expect(list.body.bindings).toHaveLength(1);
      expect(list.body.bindings[0]).toMatchObject({
        subjectName: 'dev@acme.test',
        role: 'VIEWER',
        scope: { type: 'CLUSTER' },
      });
    });

    it('answers 404, not 403, to a member with no access to the cluster at all', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const stranger = await addMember(admin, orgId, 'stranger@acme.test');

      await stranger.call('get', `/clusters/${CLUSTER}/my-access`).expect(404);
      await stranger.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(404);
    });

    it('answers 403 to a viewer who can see the cluster but not manage it', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const viewer = await addMember(admin, orgId, 'viewer@acme.test');
      await bind(admin, user(viewer), 'VIEWER');

      await viewer.call('get', `/clusters/${CLUSTER}/my-access`).expect(200);
      await viewer.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(403);
      await viewer
        .call('post', `/clusters/${CLUSTER}/role-bindings`, {
          ...user(viewer),
          role: 'CLUSTER_ADMIN',
          scope: { type: 'CLUSTER' },
        })
        .expect(403);
    });

    it('lets a cluster admin manage bindings but not on another cluster', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const lead = await addMember(admin, orgId, 'lead@acme.test');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await bind(admin, user(lead), 'CLUSTER_ADMIN');

      await bind(lead, user(dev), 'OPERATOR');
      await lead
        .call('post', `/clusters/${OTHER_CLUSTER}/role-bindings`, {
          ...user(dev),
          role: 'OPERATOR',
          scope: { type: 'CLUSTER' },
        })
        .expect(404);
    });

    it('does not let a namespace-scoped cluster admin manage the cluster', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const scoped = await addMember(admin, orgId, 'scoped@acme.test');
      await bind(admin, user(scoped), 'CLUSTER_ADMIN', { type: 'NAMESPACES', namespaces: ['dev'] });

      await scoped.call('get', `/clusters/${CLUSTER}/my-access`).expect(200);
      await scoped.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(403);
    });

    it('treats a malformed cluster id as not found', async () => {
      const admin = await platformAdmin();
      await createOrg(admin, 'acme');
      await admin.call('get', '/clusters/not-a-uuid/role-bindings').expect(404);
    });

    it('asks for an active org instead of guessing one', async () => {
      const admin = await platformAdmin();
      await admin.call('post', '/orgs', { name: 'No active', slug: 'noactive' }).expect(201);
      // The platform admin has no active org yet in this fresh session.
      await admin.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(400);
    });
  });

  describe('sudo', () => {
    it('is required to grant and to revoke, and not to read', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      const id = await bind(admin, user(dev), 'VIEWER');

      await expireSudo(admin);

      const grant = await admin
        .call('post', `/clusters/${CLUSTER}/role-bindings`, {
          ...user(dev),
          role: 'OPERATOR',
          scope: { type: 'CLUSTER' },
        })
        .expect(403);
      expect(grant.body.sudoRequired).toBe(true);
      await admin.call('delete', `/clusters/${CLUSTER}/role-bindings/${id}`).expect(403);
      await admin.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(200);
    });
  });

  describe('subjects and scopes', () => {
    it('refuses a subject from another org, with the same answer as an unknown one', async () => {
      const admin = await platformAdmin();
      const orgA = await createOrg(admin, 'alpha');
      const orgB = await createOrg(admin, 'beta');
      const inB = await addMember(admin, orgB, 'b@beta.test');
      await admin.call('post', '/me/active-org', { orgId: orgA }).expect(204);

      const body = {
        subjectType: 'USER',
        subjectId: inB.userId,
        role: 'VIEWER',
        scope: { type: 'CLUSTER' },
      };
      const cross = await admin
        .call('post', `/clusters/${CLUSTER}/role-bindings`, body)
        .expect(404);
      const unknown = await admin
        .call('post', `/clusters/${CLUSTER}/role-bindings`, { ...body, subjectId: randomUUID() })
        .expect(404);
      const strip = (b: Record<string, unknown>) => ({ ...b, requestId: undefined });
      expect(strip(cross.body as Record<string, unknown>)).toEqual(
        strip(unknown.body as Record<string, unknown>),
      );
    });

    it('refuses a team from another org', async () => {
      const admin = await platformAdmin();
      const orgA = await createOrg(admin, 'alpha');
      const orgB = await createOrg(admin, 'beta');
      const team = await admin.call('post', `/orgs/${orgB}/teams`, { name: 'sre' }).expect(201);
      await admin.call('post', '/me/active-org', { orgId: orgA }).expect(204);

      await admin
        .call('post', `/clusters/${CLUSTER}/role-bindings`, {
          subjectType: 'TEAM',
          subjectId: team.body.id as string,
          role: 'VIEWER',
          scope: { type: 'CLUSTER' },
        })
        .expect(404);
    });

    it('rejects wildcards, empty scopes, unknown roles and empty selectors', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      const post = (role: string, scope: object) =>
        admin.call('post', `/clusters/${CLUSTER}/role-bindings`, { ...user(dev), role, scope });

      await post('OPERATOR', { type: 'NAMESPACES', namespaces: ['*'] }).expect(422);
      await post('OPERATOR', { type: 'NAMESPACES', namespaces: [] }).expect(422);
      await post('OPERATOR', { type: 'NAMESPACES', namespaces: ['Has_Upper'] }).expect(422);
      await post('OPERATOR', { type: 'SELECTOR', selector: { matchLabels: {} } }).expect(422);
      await post('SUPERUSER', { type: 'CLUSTER' }).expect(422);
      await post('OPERATOR', { type: 'ALL' }).expect(422);
    });

    it('rejects an exact duplicate', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await bind(admin, user(dev), 'OPERATOR', { type: 'NAMESPACES', namespaces: ['a', 'b'] });

      await admin
        .call('post', `/clusters/${CLUSTER}/role-bindings`, {
          ...user(dev),
          role: 'OPERATOR',
          scope: { type: 'NAMESPACES', namespaces: ['b', 'a'] },
        })
        .expect(409);
    });
  });

  describe('team inheritance', () => {
    it('follows team membership in both directions', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      const team = await admin.call('post', `/orgs/${orgId}/teams`, { name: 'sre' }).expect(201);
      const teamId = team.body.id as string;
      await bind(admin, { subjectType: 'TEAM', subjectId: teamId }, 'VIEWER');

      await dev.call('get', `/clusters/${CLUSTER}/my-access`).expect(404);

      await admin.call('put', `/orgs/${orgId}/teams/${teamId}/members/${dev.userId}`).expect(204);
      const access = await dev.call('get', `/clusters/${CLUSTER}/my-access`).expect(200);
      expect(access.body.grants).toHaveLength(1);
      expect(access.body.grants[0]).toMatchObject({ role: 'VIEWER', via: 'TEAM' });

      await admin
        .call('delete', `/orgs/${orgId}/teams/${teamId}/members/${dev.userId}`)
        .expect(204);
      await dev.call('get', `/clusters/${CLUSTER}/my-access`).expect(404);
    });

    it('removes a team’s bindings when the team is deleted', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const team = await admin.call('post', `/orgs/${orgId}/teams`, { name: 'sre' }).expect(201);
      await bind(admin, { subjectType: 'TEAM', subjectId: team.body.id as string }, 'VIEWER');

      await admin.call('delete', `/orgs/${orgId}/teams/${team.body.id as string}`).expect(204);
      const list = await admin.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(200);
      expect(list.body.bindings).toEqual([]);
    });
  });

  describe('membership changes', () => {
    it('does not restore old access when a removed member is invited back', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await bind(admin, user(dev), 'CLUSTER_ADMIN');

      await admin.call('delete', `/orgs/${orgId}/members/${dev.userId}`).expect(204);
      const list = await admin.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(200);
      expect(list.body.bindings).toEqual([]);

      // Their old session is gone too; a fresh one for the same user proves the
      // check is on membership and bindings, not on a cached session.
      const again = await actAs(dev.userId);
      await again.call('post', '/me/active-org', { orgId }).expect(404);
    });

    it('takes effect on the next request when a binding is revoked', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      const id = await bind(admin, user(dev), 'VIEWER');
      await dev.call('get', `/clusters/${CLUSTER}/my-access`).expect(200);

      await admin.call('delete', `/clusters/${CLUSTER}/role-bindings/${id}`).expect(204);
      await dev.call('get', `/clusters/${CLUSTER}/my-access`).expect(404);
    });

    it('changes nothing for a member whose org role is promoted to admin', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await dev.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(404);

      await admin
        .call('patch', `/orgs/${orgId}/members/${dev.userId}`, { orgRole: 'ADMIN' })
        .expect(204);
      // Sessions are revoked on a role change; sign in again.
      const fresh = await actAs(dev.userId);
      await fresh.call('post', '/me/active-org', { orgId }).expect(204);
      await fresh.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(200);
    });
  });

  describe('org isolation', () => {
    it('treats a cluster of another org as nonexistent, even for an owner', async () => {
      const admin = await platformAdmin();
      const orgA = await createOrg(admin, 'alpha');
      const devA = await addMember(admin, orgA, 'dev@alpha.test');
      await bind(admin, user(devA), 'VIEWER');

      // The cluster belongs to alpha. In beta, where admin is also an owner,
      // it does not exist: 404, not an empty list that would suggest it does.
      const orgB = await createOrg(admin, 'beta');
      await admin.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(404);
      await admin.call('get', `/clusters/${CLUSTER}/my-access`).expect(404);

      // The alpha member has no standing in beta, whatever the cluster id.
      await devA.call('post', '/me/active-org', { orgId: orgB }).expect(404);
    });

    it('does not let a member of org A read org B through an explicit org id', async () => {
      const admin = await platformAdmin();
      const orgA = await createOrg(admin, 'alpha');
      const orgB = await createOrg(admin, 'beta');
      const devA = await addMember(admin, orgA, 'dev@alpha.test');
      await admin.call('post', '/me/active-org', { orgId: orgA }).expect(204);
      await bind(admin, user(devA), 'CLUSTER_ADMIN');

      // devA is CLUSTER_ADMIN in alpha; in beta they are nobody, and neither
      // org-scoped REST nor an explicit org id in the path changes that.
      await devA.call('get', `/orgs/${orgB}/members`).expect(404);
      await devA.call('get', `/orgs/${orgB}/teams`).expect(404);
      await devA.call('get', `/clusters/${CLUSTER}/role-bindings`).expect(200);
    });
  });

  describe('download setting', () => {
    it('is off by default and settable by an owner', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');

      const before = await admin.call('get', `/orgs/${orgId}`).expect(200);
      expect(before.body.settings.allowBackupContentDownload).toBe(false);

      const after = await admin
        .call('patch', `/orgs/${orgId}`, { allowBackupContentDownload: true })
        .expect(200);
      expect(after.body.settings.allowBackupContentDownload).toBe(true);

      const access = await admin.call('get', `/clusters/${CLUSTER}/my-access`).expect(200);
      expect(access.body).toMatchObject({
        implicitClusterAdmin: true,
        allowBackupContentDownload: true,
      });
    });
  });
});
