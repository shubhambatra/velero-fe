/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions -- response bodies are navigated as untyped JSON on purpose: the tests assert on their shape */
import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommandsService } from '../src/commands/commands.service';
import { SessionService } from '../src/auth/session.service';
import type { OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Call } from './world';

/**
 * M6 day 35: optional restore approval (PLAN.md §8.4). A restore on a cluster that requires
 * approval is held, not sent; someone other than the requester who may restore the same
 * namespaces decides it; only an approval queues it. The agent is a scripted gRPC client so
 * "nothing was sent" is something the test can actually observe.
 */
const whole = { type: 'CLUSTER' };
const only = (...namespaces: string[]) => ({ type: 'NAMESPACES', namespaces });

describe('restore approval (e2e)', () => {
  let h: TestApp;
  let world: World;

  beforeAll(async () => {
    h = await createTestApp({ gateway: true });
    world = new World(h);
    await world.init();
  }, 60_000);

  afterAll(async () => {
    world.close();
    await h.close();
  });

  beforeEach(async () => {
    await h.reset();
    h.mail.outbox = [];
    h.mail.configured = true;
  });

  async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const value = await read();
      if (ok(value)) return value;
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function setup() {
    const { call, orgId, userId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await world.connect(agent);
    stream.send({
      messageId: 's',
      snapshot: {
        snapshotId: 's1',
        sequence: 0,
        last: true,
        items: [
          resource('nightly-1', { uid: 'u-b', spec: { includedNamespaces: ['dev', 'shop'] } }),
        ],
      },
    });
    await eventually(
      () =>
        h.prisma.unscoped('t', () =>
          h.prisma.cluster.findUniqueOrThrow({ where: { id: agent.clusterId } }),
        ),
      (c) => c.inventorySnapshotId === 's1',
    );
    return {
      call,
      orgId,
      userId,
      agent,
      stream,
      base: `/orgs/${orgId}/clusters/${agent.clusterId}`,
    };
  }
  type S = Awaited<ReturnType<typeof setup>>;

  async function member(s: S, role: string, scope: object, tag = role.toLowerCase()) {
    const email = `${tag}-${Math.random().toString(36).slice(2, 7)}@acme.test`;
    const user = await world.member(s.call, s.orgId, email);
    await s
      .call('post', `/clusters/${s.agent.clusterId}/role-bindings`, {
        subjectType: 'USER',
        subjectId: user.userId,
        role,
        scope,
      })
      .expect(201);
    return { ...user, email };
  }

  const org = (s: S, on: boolean) =>
    s.call('patch', `/orgs/${s.orgId}`, { requireRestoreApproval: on }).expect(200);

  const ask = (call: Call, s: S, body: object = {}) =>
    call('post', `${s.base}/restores`, {
      backupName: 'nightly-1',
      includedNamespaces: ['shop'],
      includeClusterResources: false,
      ...body,
    });

  const rows = () =>
    h.prisma.unscoped('t', () => h.prisma.command.findMany({ where: { op: 'CREATE_RESTORE' } }));
  const row = (id: string) =>
    h.prisma.unscoped('t', () => h.prisma.command.findUniqueOrThrow({ where: { id } }));
  const list = async (call: Call, s: S, status = 'pending') =>
    (await call('get', `/orgs/${s.orgId}/approvals?status=${status}`).expect(200)).body
      .approvals as any[];

  async function silent(stream: OpenStream, ms = 400) {
    try {
      const message = await stream.next(ms);
      return message.command === undefined || message.command.refreshStatus !== undefined;
    } catch {
      return true;
    }
  }
  async function received(stream: OpenStream) {
    for (let i = 0; i < 5; i += 1) {
      const command = (await stream.next()).command;
      if (command?.createRestore !== undefined) {
        return {
          id: command.commandId,
          requestedBy: command.requestedBy,
          op: command.createRestore,
        };
      }
    }
    throw new Error('no restore arrived');
  }

  describe('when approval is not required', () => {
    it('sends the restore straight away, as before', async () => {
      const s = await setup();
      const res = await ask(s.call, s).expect(202);
      expect(res.body.status).not.toBe('PENDING_APPROVAL');
      expect((await received(s.stream)).id).toBe(res.body.id);
      expect(await list(s.call, s)).toEqual([]);
      s.stream.cancel();
    });
  });

  describe('holding a request', () => {
    it('records it, sends nothing to the agent, and keeps it out of the in-flight count', async () => {
      const s = await setup();
      await org(s, true);
      const res = await ask(s.call, s).expect(202);
      expect(res.body).toMatchObject({ op: 'CREATE_RESTORE', status: 'PENDING_APPROVAL' });
      expect(await silent(s.stream)).toBe(true);
      const stored = await row(res.body.id);
      expect(stored).toMatchObject({
        status: 'PENDING_APPROVAL',
        requestedById: s.userId,
        approvedById: null,
      });
      // The window for approval, not the agent's minute.
      expect(stored.deadlineAt.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
      s.stream.cancel();
    });

    it('is not sent when the agent reconnects either', async () => {
      const s = await setup();
      await org(s, true);
      await ask(s.call, s).expect(202);
      s.stream.cancel();
      const again = await world.connect(s.agent);
      expect(await silent(again, 600)).toBe(true);
      again.cancel();
    });

    it('is required by the cluster alone, and the org setting cannot be switched off from the cluster', async () => {
      const s = await setup();
      const policy = `${s.base}/restore-approval`;
      expect((await s.call('get', policy).expect(200)).body).toEqual({
        required: false,
        fromOrg: false,
        fromCluster: false,
      });
      await s.call('put', policy, { required: true }).expect(200);
      expect((await s.call('get', policy).expect(200)).body).toEqual({
        required: true,
        fromOrg: false,
        fromCluster: true,
      });
      expect((await ask(s.call, s).expect(202)).body.status).toBe('PENDING_APPROVAL');

      await org(s, true);
      const off = (await s.call('put', policy, { required: false }).expect(200)).body;
      expect(off).toEqual({ required: true, fromOrg: true, fromCluster: false });
      await org(s, false);
      expect((await s.call('get', policy).expect(200)).body.required).toBe(false);
      s.stream.cancel();
    });

    it('lets only a cluster manager, with a recent login, change the cluster setting', async () => {
      const s = await setup();
      const policy = `${s.base}/restore-approval`;
      const viewer = await member(s, 'VIEWER', whole);
      const operator = await member(s, 'OPERATOR', whole);
      await viewer.call('put', policy, { required: false }).expect(403);
      await operator.call('put', policy, { required: false }).expect(403);
      await viewer.call('get', policy).expect(200);
      await s.call('put', policy, { required: 'yes' }).expect(422);

      const stale = await h.app
        .get(SessionService)
        .create({ userId: s.userId, ip: '127.0.0.1', userAgent: 'v' });
      await h.app.get(SessionService).update(stale.id, { lastReauthAt: Date.now() - 10 * 60_000 });
      const res = await h
        .api()
        .put(`/api/v1${policy}`)
        .set(
          'Cookie',
          `${SessionService.COOKIE}=${stale.id}; ${SessionService.CSRF_COOKIE}=${stale.csrfToken}`,
        )
        .set('x-csrf-token', stale.csrfToken)
        .send({ required: true })
        .expect(403);
      expect(res.body.sudoRequired).toBe(true);
      s.stream.cancel();
    });
  });

  describe('approving', () => {
    it('queues it and sends the agent exactly the request, from the person who asked', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const res = await ask(requester.call, s, {
        name: 'r1',
        namespaceMapping: { shop: 'shop-copy' },
      }).expect(202);
      expect(await silent(s.stream)).toBe(true);

      const approved = await s
        .call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`)
        .expect(200);
      expect(approved.body.id).toBe(res.body.id);
      const got = await received(s.stream);
      expect(got.id).toBe(res.body.id);
      expect(got.requestedBy).toBe(requester.userId);
      expect(got.op.name).toBe('r1');
      expect(got.op.spec).toMatchObject({
        backupName: 'nightly-1',
        namespaceMapping: { shop: 'shop-copy' },
      });

      const stored = await row(res.body.id);
      expect(stored.approvedById).toBe(s.userId);
      expect(stored.decidedAt).not.toBeNull();
      // The agent's own deadline starts now, not at the request.
      expect(stored.deadlineAt.getTime() - Date.now()).toBeLessThan(5 * 60_000);
      s.stream.cancel();
    });

    it('refuses the person who asked, whatever their role, and changes nothing', async () => {
      const s = await setup();
      await org(s, true);
      const res = await ask(s.call, s).expect(202);
      const r = await s
        .call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`)
        .expect(403);
      expect(JSON.stringify(r.body)).toMatch(/someone other than/);
      await s.call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/reject`, {}).expect(403);
      expect(await row(res.body.id)).toMatchObject({
        status: 'PENDING_APPROVAL',
        approvedById: null,
        rejectedById: null,
      });
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('needs restore permission over the namespaces being written, not just any role', async () => {
      const s = await setup();
      await org(s, true);
      const res = await ask(s.call, s, { includedNamespaces: ['shop'] }).expect(202);
      const approve = (call: Call) =>
        call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`);

      await approve((await member(s, 'VIEWER', whole)).call).expect(403);
      await approve((await member(s, 'OPERATOR', whole)).call).expect(403);
      await approve((await member(s, 'RESTORER', only('dev'))).call).expect(403);
      await approve((await member(s, 'RESTORER', only('shop', 'dev'))).call).expect(200);
      expect((await row(res.body.id)).status).not.toBe('PENDING_APPROVAL');
      s.stream.cancel();
    });

    it('is a 404 for someone with no access to the cluster, and for anyone outside the org', async () => {
      const s = await setup();
      await org(s, true);
      const res = await ask(s.call, s).expect(202);
      const nobody = await world.member(s.call, s.orgId, 'nobody@acme.test');
      await nobody.call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`).expect(404);
      const outsider = await world.actAs(
        (
          await h.prisma.user.create({
            data: { id: crypto.randomUUID(), email: 'x@x.test', passwordHash: 'x' } as any,
          })
        ).id,
      );
      await outsider('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`).expect(404);
      await outsider('get', `/orgs/${s.orgId}/approvals`).expect(404);
      await s.call('post', `/orgs/${s.orgId}/approvals/${crypto.randomUUID()}/approve`).expect(404);
      s.stream.cancel();
    });

    it('is refused when the requester has lost the permission since asking', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', only('shop'));
      const res = await ask(requester.call, s).expect(202);
      await h.prisma.inOrg(s.orgId, () =>
        h.prisma.roleBinding.deleteMany({ where: { subjectId: requester.userId } }),
      );
      const r = await s
        .call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`)
        .expect(409);
      expect(JSON.stringify(r.body)).toMatch(/no longer has permission/);
      expect(await silent(s.stream)).toBe(true);
      // It can still be rejected.
      await s.call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/reject`, {}).expect(200);
      s.stream.cancel();
    });

    it('needs a recent login, like creating the restore', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const res = await ask(requester.call, s).expect(202);
      const stale = await h.app
        .get(SessionService)
        .create({ userId: s.userId, ip: '127.0.0.1', userAgent: 'v' });
      await h.app.get(SessionService).update(stale.id, { lastReauthAt: Date.now() - 10 * 60_000 });
      const r = await h
        .api()
        .post(`/api/v1/orgs/${s.orgId}/approvals/${res.body.id}/approve`)
        .set(
          'Cookie',
          `${SessionService.COOKIE}=${stale.id}; ${SessionService.CSRF_COOKIE}=${stale.csrfToken}`,
        )
        .set('x-csrf-token', stale.csrfToken)
        .expect(403);
      expect(r.body.sudoRequired).toBe(true);
      expect((await row(res.body.id)).status).toBe('PENDING_APPROVAL');
      s.stream.cancel();
    });

    it('lets exactly one of two simultaneous approvers win, and sends the restore once', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const a = await member(s, 'RESTORER', whole, 'a');
      const b = await member(s, 'RESTORER', whole, 'b');
      const res = await ask(requester.call, s).expect(202);
      const results = await Promise.all(
        [a, b, a, b].map((m) =>
          m.call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      await received(s.stream);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('cannot be approved twice, or after a rejection', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const one = await ask(requester.call, s).expect(202);
      await s.call('post', `/orgs/${s.orgId}/approvals/${one.body.id}/approve`).expect(200);
      await s.call('post', `/orgs/${s.orgId}/approvals/${one.body.id}/approve`).expect(409);
      await s.call('post', `/orgs/${s.orgId}/approvals/${one.body.id}/reject`, {}).expect(409);
      s.stream.cancel();
    });
  });

  describe('rejecting, withdrawing and expiring', () => {
    it('rejects with a reason the requester can read, and the agent never hears of it', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const res = await ask(requester.call, s).expect(202);
      await s
        .call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/reject`, { note: 'wrong backup' })
        .expect(200);
      expect(await row(res.body.id)).toMatchObject({
        status: 'REJECTED',
        rejectedById: s.userId,
        decisionNote: 'wrong backup',
      });
      expect(await silent(s.stream)).toBe(true);
      const mine = await list(requester.call, s, 'decided');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        status: 'REJECTED',
        decisionNote: 'wrong backup',
        isMine: true,
      });
      expect(mine[0].rejectedBy.email).toBe('root@vfm.local');
      await s
        .call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/reject`, { note: 'x'.repeat(501) })
        .expect(422);
      s.stream.cancel();
    });

    it('lets the requester withdraw it, and nobody else', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const res = await ask(requester.call, s).expect(202);
      const reader = await member(s, 'VIEWER', whole);
      await reader.call('post', `${s.base}/commands/${res.body.id}/cancel`).expect(403);
      await s.call('post', `${s.base}/commands/${res.body.id}/cancel`).expect(403);
      expect((await row(res.body.id)).status).toBe('PENDING_APPROVAL');
      await requester.call('post', `${s.base}/commands/${res.body.id}/cancel`).expect(200);
      expect((await row(res.body.id)).status).toBe('CANCELLED');
      const decided = await list(requester.call, s, 'decided');
      expect(decided).toMatchObject([
        { status: 'CANCELLED', isMine: true, approvedBy: null, rejectedBy: null },
      ]);
      expect(await list(requester.call, s)).toEqual([]);
      await s.call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`).expect(409);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('times out undecided, and can then be neither approved nor rejected', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const res = await ask(requester.call, s).expect(202);
      await h.prisma.unscoped('t', () =>
        h.prisma.command.update({
          where: { id: res.body.id },
          data: { deadlineAt: new Date(Date.now() - 1_000) },
        }),
      );
      await h.redis.connection.del('vfm:commands:sweeper');
      await h.app.get(CommandsService).sweepTimeouts();
      expect(await row(res.body.id)).toMatchObject({
        status: 'TIMED_OUT',
        errorCode: 'APPROVAL_EXPIRED',
      });
      await s.call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`).expect(409);
      const decided = await list(requester.call, s, 'decided');
      expect(decided.map((d) => d.status)).toEqual(['TIMED_OUT']);
      expect(decided[0].decidedAt).not.toBeNull();
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('does not approve a request whose time has run out, even before the sweeper notices', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const res = await ask(requester.call, s).expect(202);
      await h.prisma.unscoped('t', () =>
        h.prisma.command.update({
          where: { id: res.body.id },
          data: { deadlineAt: new Date(Date.now() - 1_000) },
        }),
      );
      await s.call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`).expect(409);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('limits how many requests can wait on one cluster', async () => {
      const s = await setup();
      await org(s, true);
      for (let i = 0; i < 25; i += 1) await ask(s.call, s).expect(202);
      await ask(s.call, s).expect(429);
      s.stream.cancel();
    });
  });

  describe('who sees what', () => {
    it('shows a request to its requester and to those who could decide it, and to nobody else', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const shopApprover = await member(s, 'RESTORER', only('shop'));
      const devApprover = await member(s, 'RESTORER', only('dev'));
      const viewer = await member(s, 'VIEWER', whole);
      await ask(requester.call, s).expect(202);

      const mine = await list(requester.call, s);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        isMine: true,
        canApprove: false,
        clusterName: 'prod-eu',
        status: 'PENDING_APPROVAL',
      });
      expect(mine[0].summary).toMatchObject({
        backupName: 'nightly-1',
        namespaces: ['shop'],
        includesClusterResources: false,
      });
      expect(mine[0].requestedBy.email).toBe(requester.email);

      expect((await list(shopApprover.call, s))[0]).toMatchObject({
        isMine: false,
        canApprove: true,
      });
      expect((await list(s.call, s))[0].canApprove).toBe(true);
      expect(await list(devApprover.call, s)).toEqual([]);
      expect(await list(viewer.call, s)).toEqual([]);
      expect((await s.call('get', `/orgs/${s.orgId}/approvals/count`).expect(200)).body).toEqual({
        waiting: 1,
      });
      expect(
        (await requester.call('get', `/orgs/${s.orgId}/approvals/count`).expect(200)).body,
      ).toEqual({ waiting: 0 });
      expect(
        (await viewer.call('get', `/orgs/${s.orgId}/approvals/count`).expect(200)).body,
      ).toEqual({ waiting: 0 });
      await s.call('get', `/orgs/${s.orgId}/approvals?status=all`).expect(422);
      s.stream.cancel();
    });

    it('never mixes organizations', async () => {
      const s = await setup();
      await org(s, true);
      await ask(s.call, s).expect(202);
      const other = await h.prisma.organization.create({
        data: { id: crypto.randomUUID(), name: 'B', slug: 'b' } as any,
      });
      const user = await h.prisma.user.create({
        data: { id: crypto.randomUUID(), email: 'b@b.test', passwordHash: 'x' } as any,
      });
      await h.prisma.inOrg(other.id, () =>
        h.prisma.membership.create({
          data: {
            id: crypto.randomUUID(),
            orgId: other.id,
            userId: user.id,
            orgRole: 'OWNER',
          } as any,
        }),
      );
      const b = await world.actAs(user.id);
      expect(await list(b, { ...s, orgId: other.id })).toEqual([]);
      const cmd = (await rows())[0];
      await b('post', `/orgs/${other.id}/approvals/${cmd?.id}/approve`).expect(404);
      s.stream.cancel();
    });
  });

  describe('telling people', () => {
    it('emails those who could approve, not the requester, and the requester about the outcome', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const approver = await member(s, 'RESTORER', only('shop'));
      const bystander = await member(s, 'VIEWER', whole);
      h.mail.outbox = []; // the invitations of the members above
      const res = await ask(requester.call, s).expect(202);
      await eventually(
        () => Promise.resolve(h.mail.outbox.length),
        (n) => n >= 2,
      );
      const to = h.mail.outbox.map((m) => m.to).sort();
      expect(to).toEqual(['root@vfm.local', approver.email].sort());
      expect(to).not.toContain(requester.email);
      expect(to).not.toContain(bystander.email);
      expect(h.mail.outbox[0]?.text).toMatch(/nightly-1/);
      expect(h.mail.outbox[0]?.text).toMatch(/\/approvals/);

      h.mail.outbox = [];
      await approver
        .call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/reject`, { note: 'no\r\nBcc: x' })
        .expect(200);
      await eventually(
        () => Promise.resolve(h.mail.outbox.length),
        (n) => n >= 1,
      );
      expect(h.mail.outbox[0]).toMatchObject({ to: requester.email });
      expect(h.mail.outbox[0]?.subject).toBe('[VFM] Your restore was rejected');
      expect(h.mail.outbox[0]?.text).not.toMatch(/\r|\nBcc:/);
      s.stream.cancel();
    });

    it('still works when mail is not configured', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      h.mail.configured = false;
      h.mail.outbox = [];
      const res = await ask(requester.call, s).expect(202);
      await s.call('post', `/orgs/${s.orgId}/approvals/${res.body.id}/approve`).expect(200);
      expect(h.mail.outbox).toEqual([]);
      s.stream.cancel();
    });
  });

  describe('the audit trail', () => {
    it('records the request as waiting, and each decision with who made it', async () => {
      const s = await setup();
      await org(s, true);
      const requester = await member(s, 'RESTORER', whole);
      const one = await ask(requester.call, s).expect(202);
      const two = await ask(requester.call, s).expect(202);
      await s.call('post', `/orgs/${s.orgId}/approvals/${one.body.id}/approve`).expect(200);
      await s
        .call('post', `/orgs/${s.orgId}/approvals/${two.body.id}/reject`, { note: 'no' })
        .expect(200);
      await requester
        .call(
          'post',
          `${s.base}/commands/${(await ask(requester.call, s).expect(202)).body.id}/cancel`,
        )
        .expect(200);
      await new Promise((r) => setTimeout(r, 300));
      const events = (await s.call('get', `/orgs/${s.orgId}/audit?limit=200`).expect(200)).body
        .events as any[];
      const created = events.filter(
        (e) => e.action === 'POST /orgs/:orgId/clusters/:clusterId/restores',
      );
      expect(created).toHaveLength(3);
      expect(
        created.every(
          (e) => e.details.pendingApproval === true && e.targetType === 'restore_request',
        ),
      ).toBe(true);
      expect(created.every((e) => e.actorId === requester.userId)).toBe(true);
      const approve = events.find(
        (e) => e.action === 'POST /orgs/:orgId/approvals/:commandId/approve',
      );
      const reject = events.find(
        (e) => e.action === 'POST /orgs/:orgId/approvals/:commandId/reject',
      );
      expect(approve).toMatchObject({
        actorId: s.userId,
        targetId: one.body.id,
        outcome: 'SUCCESS',
      });
      expect(reject).toMatchObject({
        actorId: s.userId,
        targetId: two.body.id,
        outcome: 'SUCCESS',
      });
      // A refused attempt is on record too.
      const self = await ask(s.call, s).expect(202);
      await s.call('post', `/orgs/${s.orgId}/approvals/${self.body.id}/approve`).expect(403);
      await new Promise((r) => setTimeout(r, 300));
      const after = (await s.call('get', `/orgs/${s.orgId}/audit?limit=200`).expect(200)).body
        .events as any[];
      expect(
        after.some(
          (e) =>
            e.action === 'POST /orgs/:orgId/approvals/:commandId/approve' && e.outcome === 'DENIED',
        ),
      ).toBe(true);
      s.stream.cancel();
    });
  });
});
