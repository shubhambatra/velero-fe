import { createHash } from 'node:crypto';

import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service';
import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { createTestApp, seedClusters, type TestApp } from './app-harness';

/**
 * End-to-end coverage of the audit log (M1 day 9) against real PostgreSQL.
 *
 * Proves: mutating routes are audited whatever their outcome (including
 * refusals that never reach a handler), values never reach the log, the log is
 * org-scoped and admin-only, the CSV export is safe to open, and the table
 * refuses UPDATE and DELETE even from the role that owns it.
 */
const PASSWORD = 'canopy-vellum-ratchet-82';
const CLUSTER = '0192f2a0-0000-7000-8000-00000000c001';

interface Event {
  id: string;
  action: string;
  outcome: string;
  actorId: string | null;
  actorEmail: string | null;
  orgId: string | null;
  targetType: string | null;
  targetId: string | null;
  clusterId: string | null;
  details: { status: number; fields: string[] };
}

describe('audit log (e2e)', () => {
  let harness: TestApp;
  let sessions: SessionService;
  let audit: AuditService;

  beforeAll(async () => {
    harness = await createTestApp();
    sessions = harness.app.get(SessionService);
    audit = harness.app.get(AuditService);
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
          .set(CSRF_HEADER, created.csrfToken)
          .set('User-Agent', 'audit-test/1.0');
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
    await seedClusters(harness.prisma, orgId, [CLUSTER]);
    return orgId;
  }

  async function addMember(owner: Actor, orgId: string, email: string): Promise<Actor> {
    await owner.call('post', `/orgs/${orgId}/invites`, { email, orgRole: 'MEMBER' }).expect(201);
    const res = await api()
      .post('/api/v1/invites/register')
      .send({ token: harness.mail.tokenFor(email), password: PASSWORD })
      .expect(201);
    const actor = await actAs(res.body.user.id as string);
    await actor.call('post', '/me/active-org', { orgId }).expect(204);
    return actor;
  }

  /** Events of an org, oldest first, once everything recorded has been written. */
  async function events(admin: Actor, orgId: string, query = ''): Promise<Event[]> {
    await audit.drain();
    const res = await admin.call('get', `/orgs/${orgId}/audit?limit=200${query}`).expect(200);
    return (res.body as { events: Event[] }).events.reverse();
  }

  describe('recording', () => {
    it('records a mutation with actor, target, ip, user agent and request id', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const team = await admin.call('post', `/orgs/${orgId}/teams`, { name: 'sre' }).expect(201);

      const log = await events(admin, orgId);
      const created = log.find((e) => e.action === 'POST /orgs/:orgId/teams');
      expect(created).toMatchObject({
        outcome: 'SUCCESS',
        actorId: admin.userId,
        actorEmail: 'root@vfm.local',
        orgId,
        details: { status: 201, fields: ['name'] },
      });
      expect(team.body.id).toBeDefined();
    });

    it('records the org creation against the new org', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');

      const log = await events(admin, orgId);
      expect(log.find((e) => e.action === 'POST /orgs')).toMatchObject({
        orgId,
        targetType: 'org',
        targetId: orgId,
      });
    });

    it('does not audit reads', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin.call('get', `/orgs/${orgId}/members`).expect(200);

      const log = await events(admin, orgId);
      expect(log.some((e) => e.action.startsWith('GET /orgs/:orgId/members'))).toBe(false);
    });

    it('names the target of a nested route by its last parameter', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      const team = await admin.call('post', `/orgs/${orgId}/teams`, { name: 'sre' }).expect(201);
      await admin
        .call('put', `/orgs/${orgId}/teams/${team.body.id as string}/members/${dev.userId}`)
        .expect(204);

      const log = await events(admin, orgId);
      expect(log.find((e) => e.action.includes('/teams/:teamId/members/:userId'))).toMatchObject({
        targetType: 'user',
        targetId: dev.userId,
      });
    });

    it('records the cluster of a cluster route', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await admin
        .call('post', `/clusters/${CLUSTER}/role-bindings`, {
          subjectType: 'USER',
          subjectId: dev.userId,
          role: 'VIEWER',
          scope: { type: 'CLUSTER' },
        })
        .expect(201);

      const log = await events(admin, orgId, `&clusterId=${CLUSTER}`);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        action: 'POST /clusters/:clusterId/role-bindings',
        clusterId: CLUSTER,
        outcome: 'SUCCESS',
      });
    });
  });

  describe('outcomes', () => {
    it('records a refusal by a guard that never reaches a handler', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');

      // RBAC refuses this before the handler runs.
      await dev
        .call('post', `/clusters/${CLUSTER}/role-bindings`, {
          subjectType: 'USER',
          subjectId: dev.userId,
          role: 'CLUSTER_ADMIN',
          scope: { type: 'CLUSTER' },
        })
        .expect(404);
      // Role check inside the handler.
      await dev.call('post', `/orgs/${orgId}/teams`, { name: 'x' }).expect(403);

      const log = await events(admin, orgId);
      expect(
        log.find((e) => e.action === 'POST /orgs/:orgId/teams' && e.actorId === dev.userId),
      ).toMatchObject({ outcome: 'DENIED', details: { status: 403 } });
      expect(log.find((e) => e.action === 'POST /clusters/:clusterId/role-bindings')).toMatchObject(
        { outcome: 'FAILED', actorId: dev.userId },
      );
    });

    it('records a validation failure as FAILED', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin.call('post', `/orgs/${orgId}/teams`, { name: '' }).expect(422);

      const log = await events(admin, orgId);
      expect(log.find((e) => e.details.status === 422)).toMatchObject({ outcome: 'FAILED' });
    });

    it('records a failed login with no actor, and never the address tried', async () => {
      await platformAdmin();
      // The table is append-only, so rows from earlier tests are still there:
      // look only at what this request adds.
      const loginRows = () =>
        harness.prisma.unscoped('test: read org-less events', () =>
          harness.prisma.auditEvent.findMany({
            where: { action: 'POST /auth/login' },
            orderBy: { id: 'desc' },
          }),
        );
      await audit.drain();
      const before = (await loginRows()).length;

      await api()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@vfm.local', password: 'wrong-wrong-wrong' })
        .expect(401);
      await audit.drain();

      const after = await loginRows();
      expect(after).toHaveLength(before + 1);
      expect(after[0]).toMatchObject({ outcome: 'DENIED', actorId: null, orgId: null });
      expect(JSON.stringify(after[0])).not.toContain('nobody@vfm.local');
    });

    it('attributes a successful login to the user who signed in', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await api()
        .post('/api/v1/auth/login')
        .send({ email: 'dev@acme.test', password: PASSWORD })
        .expect(200);
      await audit.drain();

      const rows = await harness.prisma.unscoped('test: read org-less events', () =>
        harness.prisma.auditEvent.findMany({
          where: { action: 'POST /auth/login', actorId: dev.userId },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('SUCCESS');
    });
  });

  describe('what is never written', () => {
    it('keeps passwords, tokens and secrets out of every row', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin.call('post', `/orgs/${orgId}/invites`, { email: 'secret-person@acme.test' });
      await admin.call('post', `/orgs/${orgId}/oidc-providers`, {
        displayName: 'Dex',
        issuer: 'http://localhost:55556/dex',
        clientId: 'vfm-control-plane',
        clientSecret: 'super-secret-client-secret-value',
      });
      await api()
        .post('/api/v1/invites/register')
        .send({ token: harness.mail.tokenFor('secret-person@acme.test'), password: PASSWORD });
      await audit.drain();

      const all = await harness.prisma.unscoped('test: read every event', () =>
        harness.prisma.auditEvent.findMany(),
      );
      const text = JSON.stringify(all);
      for (const forbidden of [
        PASSWORD,
        'super-secret-client-secret-value',
        harness.mail.tokenFor('secret-person@acme.test'),
      ]) {
        expect(text).not.toContain(forbidden);
      }
      // …but the field *names* are, which is what an auditor needs.
      expect(text).toContain('clientSecret');
    });
  });

  describe('reading', () => {
    it('is limited to Owner and Admin', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');

      await dev.call('get', `/orgs/${orgId}/audit`).expect(403);
      await dev.call('get', `/orgs/${orgId}/audit/export`).expect(403);
    });

    it('does not show another org’s events', async () => {
      const admin = await platformAdmin();
      const orgA = await createOrg(admin, 'alpha');
      await admin.call('post', `/orgs/${orgA}/teams`, { name: 'alpha-team' }).expect(201);
      const orgB = await createOrg(admin, 'beta');
      await admin.call('post', `/orgs/${orgB}/teams`, { name: 'beta-team' }).expect(201);

      const inB = await events(admin, orgB);
      expect(inB.every((e) => e.orgId === orgB)).toBe(true);
      expect(inB.some((e) => e.targetId === orgA)).toBe(false);
    });

    it('filters by actor, action, outcome and time', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await dev.call('post', `/orgs/${orgId}/teams`, { name: 'x' }).expect(403);
      await admin.call('post', `/orgs/${orgId}/teams`, { name: 'ok' }).expect(201);

      const byActor = await events(admin, orgId, `&actorId=${dev.userId}`);
      expect(byActor.length).toBeGreaterThan(0);
      expect(byActor.every((e) => e.actorId === dev.userId)).toBe(true);

      const denied = await events(admin, orgId, '&outcome=DENIED');
      expect(denied.map((e) => e.action)).toContain('POST /orgs/:orgId/teams');

      const byAction = await events(admin, orgId, '&action=invites');
      expect(byAction.every((e) => e.action.includes('invites'))).toBe(true);

      const future = await events(admin, orgId, '&from=2999-01-01T00:00:00Z');
      expect(future).toEqual([]);
    });

    it('pages with a cursor, newest first', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      for (const name of ['a', 'b', 'c']) {
        await admin.call('post', `/orgs/${orgId}/teams`, { name }).expect(201);
      }
      await audit.drain();

      const first = await admin.call('get', `/orgs/${orgId}/audit?limit=2`).expect(200);
      expect(first.body.events).toHaveLength(2);
      expect(first.body.nextCursor).toBeTruthy();
      const second = await admin
        .call('get', `/orgs/${orgId}/audit?limit=2&cursor=${first.body.nextCursor as string}`)
        .expect(200);
      const ids = (body: unknown): string[] =>
        (body as { events: { id: string }[] }).events.map((e) => e.id);
      const all = [...ids(first.body), ...ids(second.body)];
      expect(new Set(all).size).toBe(all.length);
      expect(all).toEqual([...all].sort().reverse());
    });

    it('rejects out-of-range paging parameters', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin.call('get', `/orgs/${orgId}/audit?limit=100000`).expect(422);
      await admin.call('get', `/orgs/${orgId}/audit?cursor=nope`).expect(422);
    });
  });

  describe('CSV export', () => {
    it('streams a header and rows, defuses formulas, and is itself audited', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await admin
        .call('post', `/orgs/${orgId}/teams`, { name: '=HYPERLINK("http://evil")' })
        .expect(201);
      await audit.drain();

      const res = await admin.call('get', `/orgs/${orgId}/audit/export`).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('audit-log.csv');
      const lines = res.text.trim().split('\r\n');
      expect(lines[0]).toBe(
        'time,actor_type,actor_id,actor_email,action,target_type,target_id,cluster_id,outcome,ip,user_agent,request_id,details',
      );
      expect(lines.length).toBeGreaterThan(2);

      await audit.drain();
      const log = await events(admin, orgId);
      expect(log.some((e) => e.action === 'audit.export')).toBe(true);
    });
  });

  describe('append-only', () => {
    async function anEventId(): Promise<string> {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const log = await events(admin, orgId);
      return log[0]?.id ?? '';
    }

    it('refuses UPDATE even from the role that owns the table', async () => {
      const id = await anEventId();
      await expect(
        harness.prisma.unscoped('test: prove immutability', () =>
          harness.prisma.auditEvent.update({ where: { id }, data: { action: 'tampered' } }),
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses DELETE, deleteMany and TRUNCATE', async () => {
      const id = await anEventId();
      await expect(
        harness.prisma.unscoped('test: prove immutability', () =>
          harness.prisma.auditEvent.delete({ where: { id } }),
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        harness.prisma.unscoped('test: prove immutability', () =>
          harness.prisma.auditEvent.deleteMany(),
        ),
      ).rejects.toThrow(/append-only/);
      await expect(harness.prisma.$executeRawUnsafe('TRUNCATE TABLE audit_events')).rejects.toThrow(
        /append-only/,
      );
    });

    it('survives the deletion of its org', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      await audit.drain();

      await harness.prisma.organization.deleteMany();
      const left = await harness.prisma.unscoped('test: read after org delete', () =>
        harness.prisma.auditEvent.count({ where: { orgId } }),
      );
      expect(left).toBeGreaterThan(0);
    });
  });
});
