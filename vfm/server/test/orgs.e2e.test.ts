import { createHash } from 'node:crypto';

import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { createTestApp, type TestApp } from './app-harness';

/**
 * End-to-end coverage of M1 day 6 — orgs, members, invites, teams and org
 * scoping — against real PostgreSQL and Redis.
 *
 * The acceptance criteria this exists to prove (NEXT_STEPS.md):
 *  - an invite cannot be replayed or accepted by a different address,
 *  - a user in two orgs sees only the org they ask about,
 *  - org scoping cannot be bypassed from the REST surface.
 */
const PASSWORD = 'canopy-vellum-ratchet-82';

/** Typed readers over supertest's `any` bodies, so the assertions stay lint-clean. */
const emails = (body: unknown): string[] =>
  (body as { members: { email: string }[] }).members.map((m) => m.email);
const names = (body: unknown): string[] =>
  (body as { teams: { name: string }[] }).teams.map((t) => t.name);
const orgsOf = (body: unknown): { id: string; active: boolean }[] =>
  (body as { orgs: { id: string; active: boolean }[] }).orgs;
const ADMIN_EMAIL = 'root@vfm.local';

describe('orgs, invites and teams (e2e)', () => {
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
    call: (
      method: 'get' | 'post' | 'patch' | 'put' | 'delete',
      path: string,
      body?: object,
    ) => request.Test;
  }

  /** Acts as `userId` using a freshly minted session, as if just signed in. */
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
      .send({ token, email: ADMIN_EMAIL, password: PASSWORD })
      .expect(201);
    return actAs(res.body.user.id as string);
  }

  async function createOrg(admin: Actor, slug: string): Promise<string> {
    const res = await admin.call('post', '/orgs', { name: `Org ${slug}`, slug }).expect(201);
    return res.body.id as string;
  }

  /** Invites `email` as `orgRole`, has them register, and returns them as an actor. */
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
    return actAs(res.body.user.id as string);
  }

  describe('organizations', () => {
    it('lets a platform admin create an org and makes them its Owner', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');

      const res = await admin.call('get', `/orgs/${orgId}`).expect(200);
      expect(res.body).toMatchObject({ slug: 'acme', orgRole: 'OWNER' });
    });

    it('refuses org creation to anyone else', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const member = await addMember(admin, orgId, 'dev@acme.test');

      await member.call('post', '/orgs', { name: 'Mine', slug: 'mine' }).expect(403);
    });

    it('rejects a duplicate slug and a malformed one', async () => {
      const admin = await platformAdmin();
      await createOrg(admin, 'acme');
      await admin.call('post', '/orgs', { name: 'Again', slug: 'acme' }).expect(409);
      await admin.call('post', '/orgs', { name: 'Bad', slug: 'Not A Slug!' }).expect(422);
    });

    it('stores the MFA policy in settings', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const res = await admin.call('patch', `/orgs/${orgId}`, { mfaRequired: true }).expect(200);
      expect(res.body.settings.mfaRequired).toBe(true);
    });
  });

  describe('invitations', () => {
    it('emails a single-use link and creates the account on acceptance', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');

      await admin.call('post', `/orgs/${orgId}/invites`, { email: 'New@Acme.test' }).expect(201);
      expect(harness.mail.outbox).toHaveLength(1);
      expect(harness.mail.outbox[0]?.to).toBe('new@acme.test');

      const token = harness.mail.tokenFor('new@acme.test');
      const res = await api()
        .post('/api/v1/invites/register')
        .send({ token, password: PASSWORD })
        .expect(201);
      expect(res.body.orgId).toBe(orgId);
      // A plain member owes no second factor, so the session is usable.
      expect(res.body.mfaPendingReason).toBeNull();

      const members = await admin.call('get', `/orgs/${orgId}/members`).expect(200);
      expect(emails(members.body)).toContain('new@acme.test');
    });

    it('cannot be replayed', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin.call('post', `/orgs/${orgId}/invites`, { email: 'a@acme.test' }).expect(201);
      const token = harness.mail.tokenFor('a@acme.test');

      await api().post('/api/v1/invites/register').send({ token, password: PASSWORD }).expect(201);
      await api().post('/api/v1/invites/register').send({ token, password: PASSWORD }).expect(400);
    });

    it('cannot be accepted by a different address', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const intruder = await addMember(admin, orgId, 'intruder@acme.test');

      // A second org the intruder is not part of, and an invite to someone else.
      const other = await createOrg(admin, 'other');
      await admin
        .call('post', `/orgs/${other}/invites`, { email: 'target@other.test' })
        .expect(201);
      const token = harness.mail.tokenFor('target@other.test');

      await intruder.call('post', '/invites/accept', { token }).expect(400);

      const members = await admin.call('get', `/orgs/${other}/members`).expect(200);
      expect(emails(members.body)).not.toContain('intruder@acme.test');
      // The legitimate token is still good: the failed attempt did not burn it.
      await api().post('/api/v1/invites/register').send({ token, password: PASSWORD }).expect(201);
    });

    it('lets an existing account accept, once', async () => {
      const admin = await platformAdmin();
      const a = await createOrg(admin, 'alpha');
      const b = await createOrg(admin, 'beta');
      const user = await addMember(admin, a, 'two@orgs.test');

      await admin.call('post', `/orgs/${b}/invites`, { email: 'two@orgs.test' }).expect(201);
      const token = harness.mail.tokenFor('two@orgs.test');

      await user.call('post', '/invites/accept', { token }).expect(201);
      await user.call('post', '/invites/accept', { token }).expect(400);

      const orgs = await user.call('get', '/me/orgs').expect(200);
      expect(orgs.body.orgs).toHaveLength(2);
    });

    it('refuses registration over an address that already has an account', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await addMember(admin, orgId, 'exists@acme.test');
      const other = await createOrg(admin, 'other');
      await admin.call('post', `/orgs/${other}/invites`, { email: 'exists@acme.test' }).expect(201);
      const token = harness.mail.tokenFor('exists@acme.test');

      await api()
        .post('/api/v1/invites/register')
        .send({ token, password: 'another-long-password-91' })
        .expect(400);
    });

    it('is refused after expiry', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin.call('post', `/orgs/${orgId}/invites`, { email: 'late@acme.test' }).expect(201);
      const token = harness.mail.tokenFor('late@acme.test');

      await harness.prisma.unscoped('test: age an invite', () =>
        harness.prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1_000) } }),
      );

      await api().post('/api/v1/invites/register').send({ token, password: PASSWORD }).expect(400);
    });

    it('stores only a hash of the token', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin.call('post', `/orgs/${orgId}/invites`, { email: 'h@acme.test' }).expect(201);
      const token = harness.mail.tokenFor('h@acme.test');

      const rows = await harness.prisma.unscoped('test: read raw invite rows', () =>
        harness.prisma.invite.findMany(),
      );
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it('fails with 503 and stores nothing when mail is not configured', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      harness.mail.configured = false;

      await admin.call('post', `/orgs/${orgId}/invites`, { email: 'x@acme.test' }).expect(503);
      const pending = await admin.call('get', `/orgs/${orgId}/invites`).expect(200);
      expect(pending.body.invites).toEqual([]);
    });

    it('removes the invitation when the relay refuses the message', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      harness.mail.failNext = true;

      await admin.call('post', `/orgs/${orgId}/invites`, { email: 'x@acme.test' }).expect(500);
      const pending = await admin.call('get', `/orgs/${orgId}/invites`).expect(200);
      expect(pending.body.invites).toEqual([]);
    });

    it('can be revoked, after which the link is dead', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const created = await admin
        .call('post', `/orgs/${orgId}/invites`, { email: 'r@acme.test' })
        .expect(201);
      const token = harness.mail.tokenFor('r@acme.test');

      await admin.call('delete', `/orgs/${orgId}/invites/${created.body.id as string}`).expect(204);
      await api().post('/api/v1/invites/register').send({ token, password: PASSWORD }).expect(400);
    });

    it('makes a new Admin owe MFA enrolment straight away', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin
        .call('post', `/orgs/${orgId}/invites`, { email: 'adm@acme.test', orgRole: 'ADMIN' })
        .expect(201);

      const res = await api()
        .post('/api/v1/invites/register')
        .send({ token: harness.mail.tokenFor('adm@acme.test'), password: PASSWORD })
        .expect(201);
      expect(res.body.mfaPendingReason).toBe('enrolment');
    });
  });

  describe('org isolation', () => {
    it('shows a user in two orgs only the org they ask about', async () => {
      const admin = await platformAdmin();
      const a = await createOrg(admin, 'alpha');
      const b = await createOrg(admin, 'beta');

      await admin.call('post', `/orgs/${a}/teams`, { name: 'alpha-ops' }).expect(201);
      await admin.call('post', `/orgs/${b}/teams`, { name: 'beta-ops' }).expect(201);
      await addMember(admin, a, 'only-a@x.test');

      const teamsA = await admin.call('get', `/orgs/${a}/teams`).expect(200);
      const teamsB = await admin.call('get', `/orgs/${b}/teams`).expect(200);
      expect(names(teamsA.body)).toEqual(['alpha-ops']);
      expect(names(teamsB.body)).toEqual(['beta-ops']);

      const membersB = await admin.call('get', `/orgs/${b}/members`).expect(200);
      expect(emails(membersB.body)).toEqual([ADMIN_EMAIL]);
    });

    it('answers 404 — not 403 — for an org the caller does not belong to', async () => {
      const admin = await platformAdmin();
      const a = await createOrg(admin, 'alpha');
      const b = await createOrg(admin, 'beta');
      const member = await addMember(admin, a, 'm@alpha.test');

      for (const path of [
        `/orgs/${b}`,
        `/orgs/${b}/members`,
        `/orgs/${b}/teams`,
        `/orgs/${b}/invites`,
      ]) {
        await member.call('get', path).expect(404);
      }
      await member.call('post', `/orgs/${b}/teams`, { name: 'x' }).expect(404);
    });

    it('does not let a team in one org take a member of another', async () => {
      const admin = await platformAdmin();
      const a = await createOrg(admin, 'alpha');
      const b = await createOrg(admin, 'beta');
      const outsider = await addMember(admin, b, 'b-only@x.test');
      const team = await admin.call('post', `/orgs/${a}/teams`, { name: 'ops' }).expect(201);

      await admin
        .call('put', `/orgs/${a}/teams/${team.body.id as string}/members/${outsider.userId}`)
        .expect(404);
    });

    it('does not let a team id from another org be addressed through this one', async () => {
      const admin = await platformAdmin();
      const a = await createOrg(admin, 'alpha');
      const b = await createOrg(admin, 'beta');
      const teamInB = await admin.call('post', `/orgs/${b}/teams`, { name: 'secret' }).expect(201);

      await admin.call('delete', `/orgs/${a}/teams/${teamInB.body.id as string}`).expect(404);
      await admin
        .call('patch', `/orgs/${a}/teams/${teamInB.body.id as string}`, { name: 'x' })
        .expect(404);
      const still = await admin.call('get', `/orgs/${b}/teams`).expect(200);
      expect(still.body.teams).toHaveLength(1);
    });
  });

  describe('the org switcher', () => {
    it('lists memberships, flags the active one and accepts a switch', async () => {
      const admin = await platformAdmin();
      const a = await createOrg(admin, 'alpha');
      const b = await createOrg(admin, 'beta');

      let res = await admin.call('get', '/me/orgs').expect(200);
      expect(res.body.orgs).toHaveLength(2);
      expect(orgsOf(res.body).filter((o) => o.active)).toHaveLength(1);

      await admin.call('post', '/me/active-org', { orgId: b }).expect(204);
      res = await admin.call('get', '/me/orgs').expect(200);
      expect(orgsOf(res.body).find((o) => o.active)?.id).toBe(b);
      expect(a).not.toBe(b);
    });

    it('refuses to activate an org the caller is not in', async () => {
      const admin = await platformAdmin();
      const a = await createOrg(admin, 'alpha');
      const b = await createOrg(admin, 'beta');
      const member = await addMember(admin, a, 'm@alpha.test');

      await member.call('post', '/me/active-org', { orgId: b }).expect(404);
    });
  });

  describe('roles', () => {
    it('keeps at least one Owner', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');

      await admin
        .call('patch', `/orgs/${orgId}/members/${admin.userId}`, { orgRole: 'ADMIN' })
        .expect(409);
      await admin.call('delete', `/orgs/${orgId}/members/${admin.userId}`).expect(409);
    });

    it('stops an Admin changing an Owner or minting one', async () => {
      const owner = await platformAdmin();
      const orgId = await createOrg(owner, 'acme');
      const member = await addMember(owner, orgId, 'adm@acme.test');
      await owner
        .call('patch', `/orgs/${orgId}/members/${member.userId}`, { orgRole: 'ADMIN' })
        .expect(204);
      const adminActor = await actAs(member.userId);

      await adminActor
        .call('patch', `/orgs/${orgId}/members/${owner.userId}`, { orgRole: 'MEMBER' })
        .expect(403);
      await adminActor
        .call('patch', `/orgs/${orgId}/members/${member.userId}`, { orgRole: 'OWNER' })
        .expect(403);
      await adminActor.call('delete', `/orgs/${orgId}/members/${owner.userId}`).expect(403);
    });

    it('ends the target’s sessions when their role changes', async () => {
      const owner = await platformAdmin();
      const orgId = await createOrg(owner, 'acme');
      const member = await addMember(owner, orgId, 'm@acme.test');
      await member.call('get', '/me/orgs').expect(200);

      await owner
        .call('patch', `/orgs/${orgId}/members/${member.userId}`, { orgRole: 'ADMIN' })
        .expect(204);

      await member.call('get', '/me/orgs').expect(401);
    });

    it('stops a plain member managing anything', async () => {
      const owner = await platformAdmin();
      const orgId = await createOrg(owner, 'acme');
      const member = await addMember(owner, orgId, 'm@acme.test');

      await member.call('post', `/orgs/${orgId}/invites`, { email: 'z@acme.test' }).expect(403);
      await member.call('post', `/orgs/${orgId}/teams`, { name: 'x' }).expect(403);
      await member.call('patch', `/orgs/${orgId}`, { name: 'Mine' }).expect(403);
      await member.call('get', `/orgs/${orgId}/members`).expect(200);
    });

    it('requires sudo to remove a member', async () => {
      const owner = await platformAdmin();
      const orgId = await createOrg(owner, 'acme');
      const member = await addMember(owner, orgId, 'm@acme.test');

      const created = await sessions.create({
        userId: owner.userId,
        ip: '127.0.0.1',
        userAgent: 'v',
      });
      await sessions.update(created.id, { lastReauthAt: Date.now() - 10 * 60_000 });
      const cookie = `${SessionService.COOKIE}=${created.id}; ${SessionService.CSRF_COOKIE}=${created.csrfToken}`;

      await api()
        .delete(`/api/v1/orgs/${orgId}/members/${member.userId}`)
        .set('Cookie', cookie)
        .set(CSRF_HEADER, created.csrfToken)
        .expect(403);

      await owner.call('delete', `/orgs/${orgId}/members/${member.userId}`).expect(204);
    });
  });

  describe('teams', () => {
    it('supports create, rename, membership and delete', async () => {
      const owner = await platformAdmin();
      const orgId = await createOrg(owner, 'acme');
      const member = await addMember(owner, orgId, 'm@acme.test');

      const team = await owner.call('post', `/orgs/${orgId}/teams`, { name: 'ops' }).expect(201);
      const teamId = team.body.id as string;
      await owner.call('post', `/orgs/${orgId}/teams`, { name: 'ops' }).expect(409);

      await owner
        .call('put', `/orgs/${orgId}/teams/${teamId}/members/${member.userId}`)
        .expect(204);
      await owner
        .call('put', `/orgs/${orgId}/teams/${teamId}/members/${member.userId}`)
        .expect(409);

      const listed = await owner.call('get', `/orgs/${orgId}/teams`).expect(200);
      expect(listed.body.teams[0]).toMatchObject({ name: 'ops', memberCount: 1 });

      await owner.call('patch', `/orgs/${orgId}/teams/${teamId}`, { name: 'platform' }).expect(204);
      await owner
        .call('delete', `/orgs/${orgId}/teams/${teamId}/members/${member.userId}`)
        .expect(204);
      await owner.call('delete', `/orgs/${orgId}/teams/${teamId}`).expect(204);
      await owner.call('get', `/orgs/${orgId}/teams/${teamId}/members`).expect(404);
    });

    it('drops a removed member from their teams', async () => {
      const owner = await platformAdmin();
      const orgId = await createOrg(owner, 'acme');
      const member = await addMember(owner, orgId, 'm@acme.test');
      const team = await owner.call('post', `/orgs/${orgId}/teams`, { name: 'ops' }).expect(201);
      const teamId = team.body.id as string;
      await owner
        .call('put', `/orgs/${orgId}/teams/${teamId}/members/${member.userId}`)
        .expect(204);

      await owner.call('delete', `/orgs/${orgId}/members/${member.userId}`).expect(204);

      const members = await owner.call('get', `/orgs/${orgId}/teams/${teamId}/members`).expect(200);
      expect(members.body.members).toEqual([]);
    });
  });

  describe('lockout notification (PLAN.md §8.3)', () => {
    it('emails the account holder once, and says nothing about unknown addresses', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await addMember(admin, orgId, 'victim@acme.test');
      harness.mail.outbox = [];

      for (let i = 0; i < 12; i += 1) {
        await api()
          .post('/api/v1/auth/login')
          .send({ email: 'victim@acme.test', password: 'wrong-password-' + String(i) })
          .then((r) => {
            expect([401, 429]).toContain(r.status);
          });
      }
      for (let i = 0; i < 12; i += 1) {
        await api()
          .post('/api/v1/auth/login')
          .send({ email: 'ghost@acme.test', password: 'wrong-password-' + String(i) })
          .then((r) => {
            expect([401, 429]).toContain(r.status);
          });
      }

      // The send is deliberately not awaited by the login path; let it settle.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const lockout = harness.mail.outbox.filter((m) => m.subject.includes('locked'));
      expect(lockout).toHaveLength(1);
      expect(lockout[0]?.to).toBe('victim@acme.test');
    }, 120_000);
  });
});
