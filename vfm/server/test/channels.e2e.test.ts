/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions -- response bodies are navigated as untyped JSON on purpose: the tests assert on their shape */
import 'reflect-metadata';

import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { deliveryOptions } from '../src/alerts/channels/channel-notifier';
import { ChannelsService } from '../src/alerts/channels/channels.service';
import { AlertsService } from '../src/alerts/alerts.service';
import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { newId } from '../src/common/uuid';
import { createTestApp, type TestApp } from './app-harness';
import { World, type Call } from './world';

/**
 * M6 day 33: channels and delivery, against a real local receiver. The webhook is signed and
 * the test recomputes the signature the way a receiver would; the destination rules are the
 * real ones, switched on and off through the service's policy.
 */
const NOW = new Date();
const at = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);
const SECRET_PATH = 'T0000/B0000/CANARY-slack-credential-91f3';

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('channels and delivery (e2e)', () => {
  let h: TestApp;
  let world: World;
  let engine: AlertsService;
  let channels: ChannelsService;
  let receiver: http.Server;
  let base = '';
  let received: Received[];
  /** Status the receiver answers with, by path prefix. */
  let answers: Record<string, number>;

  beforeAll(async () => {
    h = await createTestApp();
    world = new World(h);
    await world.init();
    engine = h.app.get(AlertsService);
    channels = h.app.get(ChannelsService);
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        const status =
          Object.entries(answers).find(([p]) => (req.url ?? '').startsWith(p))?.[1] ?? 200;
        res.writeHead(status).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    receiver.close();
    world.close();
    await h.close();
  });

  beforeEach(async () => {
    await h.reset();
    received = [];
    answers = {};
    channels.policy.allowPrivate = true;
    channels.policy.allowHttp = true;
    deliveryOptions.backoffMs = [1, 1];
    deliveryOptions.retryAfterMs = 5 * 60_000;
    h.mail.outbox = [];
    h.mail.configured = true;
  });

  async function org() {
    const { call, orgId, userId } = await world.admin();
    const cluster = (await call('post', `/orgs/${orgId}/clusters`, { name: 'prod-eu' }).expect(201))
      .body.cluster.id as string;
    return { call, orgId, userId, clusterId: cluster };
  }

  const make = (call: Call, orgId: string, body: object) =>
    call('post', `/orgs/${orgId}/channels`, body);
  const webhook = (call: Call, orgId: string, path = '/hook', name = 'hook') =>
    make(call, orgId, { name, type: 'WEBHOOK', config: { url: `${base}${path}` } });
  const slack = (call: Call, orgId: string, path = `/slack/${SECRET_PATH}`, name = 'slack') =>
    make(call, orgId, { name, type: 'SLACK_WEBHOOK', config: { url: `${base}${path}` } });
  const email = (call: Call, orgId: string, to = ['ops@acme.test'], name = 'mail') =>
    make(call, orgId, { name, type: 'EMAIL', config: { to } });

  async function failingBackup(orgId: string, clusterId: string, name = 'nightly-1', hours = 1) {
    await h.prisma.inOrg(orgId, () =>
      h.prisma.veleroResource.create({
        data: {
          id: newId(),
          orgId,
          clusterId,
          kind: 'BACKUP',
          namespace: 'velero',
          name,
          uid: randomUUID(),
          resourceVersion: '1',
          phase: 'Failed',
          completedAt: at(hours),
          creationTimestamp: at(hours),
          labels: { 'velero.io/schedule-name': 'nightly' },
          status: { failureReason: 'BackupStorageLocation "default" is unavailable' },
        } as any,
      }),
    );
  }
  const fix = (orgId: string, clusterId: string) =>
    h.prisma.inOrg(orgId, () =>
      h.prisma.veleroResource.create({
        data: {
          id: newId(),
          orgId,
          clusterId,
          kind: 'BACKUP',
          namespace: 'velero',
          name: 'nightly-ok',
          uid: randomUUID(),
          resourceVersion: '1',
          phase: 'Completed',
          completedAt: at(0.1),
          creationTimestamp: at(0.1),
          labels: { 'velero.io/schedule-name': 'nightly' },
        } as any,
      }),
    );
  const rule = (call: Call, orgId: string, channelIds: string[], body: object = {}) =>
    call('post', `/orgs/${orgId}/alerts/rules`, {
      name: 'Failed backups',
      type: 'BACKUP_FAILED',
      channelIds,
      ...body,
    });
  const events = async (call: Call, orgId: string) =>
    (await call('get', `/orgs/${orgId}/alerts/events`).expect(200)).body.events as any[];
  const parse = (r: Received) => JSON.parse(r.body);

  describe('managing channels', () => {
    it('is for owners and admins, and invisible to anyone outside the org', async () => {
      const { call, orgId } = await org();
      const member = await world.member(call, orgId, 'm@acme.test');
      await member.call('get', `/orgs/${orgId}/channels`).expect(403);
      await email(member.call, orgId).expect(403);
      const made = (await email(call, orgId).expect(201)).body;
      await member.call('post', `/orgs/${orgId}/channels/${made.id}/test`).expect(403);

      const outsider = await world.actAs(
        (
          await h.prisma.user.create({
            data: { id: newId(), email: 'x@x.test', passwordHash: 'x' } as any,
          })
        ).id,
      );
      await outsider('get', `/orgs/${orgId}/channels`).expect(404);
      await outsider('patch', `/orgs/${orgId}/channels/${made.id}`, { name: 'x' }).expect(404);
      await outsider('post', `/orgs/${orgId}/channels/${made.id}/test`).expect(404);
    });

    it('keeps one org’s channels from another’s admin, even by id', async () => {
      const a = await org();
      const made = (await email(a.call, a.orgId).expect(201)).body;
      const other = await h.prisma.organization.create({
        data: { id: newId(), name: 'B', slug: 'b' } as any,
      });
      const user = await h.prisma.user.create({
        data: { id: newId(), email: 'b@b.test', passwordHash: 'x' } as any,
      });
      await h.prisma.inOrg(other.id, () =>
        h.prisma.membership.create({
          data: { id: newId(), orgId: other.id, userId: user.id, orgRole: 'OWNER' } as any,
        }),
      );
      const b = await world.actAs(user.id);
      await b('get', `/orgs/${other.id}/channels`)
        .expect(200)
        .then((r) => {
          expect(r.body.channels).toEqual([]);
        });
      await b('patch', `/orgs/${other.id}/channels/${made.id}`, { name: 'mine' }).expect(404);
      await b('post', `/orgs/${other.id}/channels/${made.id}/test`).expect(404);
      await b('delete', `/orgs/${other.id}/channels/${made.id}`).expect(404);
    });

    it('creates each type, shows a destination’s origin and never its secret path', async () => {
      const { call, orgId } = await org();
      const hook = (await webhook(call, orgId).expect(201)).body;
      expect(hook.secret).toMatch(/^whsec_[\w-]{43}$/);
      expect(hook.config).toEqual({ destination: base, signed: true });
      const chat = (await slack(call, orgId).expect(201)).body;
      expect(chat.secret).toBeUndefined();
      expect(chat.config).toEqual({ destination: base });
      const mail = (await email(call, orgId, ['a@acme.test', 'b@acme.test']).expect(201)).body;
      expect(mail.config).toEqual({ to: ['a@acme.test', 'b@acme.test'] });

      const list = (await call('get', `/orgs/${orgId}/channels`).expect(200)).body
        .channels as any[];
      expect(list.map((c) => c.type)).toEqual(['WEBHOOK', 'SLACK_WEBHOOK', 'EMAIL']);
      const text = JSON.stringify(list);
      expect(text).not.toContain(SECRET_PATH);
      expect(text).not.toContain('whsec_');
    });

    it('stores the destination encrypted and writes it nowhere else', async () => {
      const { call, orgId } = await org();
      const hook = (await webhook(call, orgId, `/hook/${SECRET_PATH}`).expect(201)).body;
      await slack(call, orgId).expect(201);
      const rows = await h.prisma.$queryRawUnsafe<{ config_encrypted: string }[]>(
        'SELECT config_encrypted FROM notification_channels',
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.config_encrypted).not.toContain(SECRET_PATH);
        expect(r.config_encrypted).not.toContain('127.0.0.1');
        expect(r.config_encrypted).not.toContain(hook.secret);
      }
      const audit = JSON.stringify(
        await h.prisma.$queryRawUnsafe('SELECT details, action, target_id FROM audit_events'),
      );
      expect(audit).not.toContain(SECRET_PATH);
      expect(audit).not.toContain(hook.secret);
      expect(audit).toContain('/orgs/:orgId/channels');
    });

    it('refuses destinations it must not send to, and says why', async () => {
      const { call, orgId } = await org();
      channels.policy.allowPrivate = false;
      channels.policy.allowHttp = false;
      const bad = async (type: string, config: object, why: RegExp) => {
        const r = await make(call, orgId, { name: `n${Math.random()}`, type, config }).expect(400);
        expect(r.body.detail ?? r.body.message ?? JSON.stringify(r.body)).toMatch(why);
      };
      await bad('WEBHOOK', { url: 'http://example.com/x' }, /plain http/);
      await bad('WEBHOOK', { url: 'https://127.0.0.1/x' }, /not allowed/);
      await bad('WEBHOOK', { url: 'https://localhost/x' }, /not allowed/);
      await bad('WEBHOOK', { url: 'https://[::ffff:10.0.0.1]/x' }, /not allowed/);
      await bad('SLACK_WEBHOOK', { url: 'https://169.254.169.254/latest' }, /not allowed/);
      await bad('SLACK_WEBHOOK', { url: 'https://user:pw@hooks.example.com/x' }, /user name/);
      await bad('WEBHOOK', { url: 'ftp://example.com/x' }, /https/);
      await bad('WEBHOOK', { url: 'nonsense' }, /not valid/);
      channels.policy.allowPrivate = true;
      channels.policy.allowHttp = true;
      await bad('SLACK_WEBHOOK', { url: 'http://169.254.169.254/latest' }, /not allowed/);
    });

    it('validates the shape of what it is given', async () => {
      const { call, orgId } = await org();
      await make(call, orgId, { name: 'x', type: 'NOPE', config: {} }).expect(422);
      await make(call, orgId, { name: '', type: 'EMAIL', config: { to: ['a@b.co'] } }).expect(422);
      await make(call, orgId, { name: 'x', type: 'EMAIL', config: { to: [] } }).expect(400);
      await make(call, orgId, {
        name: 'x',
        type: 'EMAIL',
        config: { to: ['not-an-email'] },
      }).expect(400);
      await make(call, orgId, {
        name: 'x',
        type: 'EMAIL',
        config: { to: ['a@b.co'], secret: 'x' },
      }).expect(400);
      await make(call, orgId, {
        name: 'x',
        type: 'WEBHOOK',
        config: { url: `${base}/h`, secret: 'mine' },
      }).expect(400);
      await make(call, orgId, {
        name: 'x',
        type: 'EMAIL',
        config: { to: ['a@b.co'] },
        extra: 1,
      }).expect(422);
      await email(call, orgId, ['a@b.co'], 'same').expect(201);
      await email(call, orgId, ['a@b.co'], 'same').expect(409);
    });

    it('changes a channel and keeps the secret, or makes a new one once', async () => {
      const { call, orgId } = await org();
      const hook = (await webhook(call, orgId).expect(201)).body;
      const moved = await call('patch', `/orgs/${orgId}/channels/${hook.id}`, {
        name: 'renamed',
        config: { url: `${base}/elsewhere` },
      }).expect(200);
      expect(moved.body.name).toBe('renamed');
      expect(moved.body.secret).toBeUndefined();

      await call('post', `/orgs/${orgId}/channels/${hook.id}/test`).expect(200);
      const first = received.at(-1) as Received;
      expect(first.path).toBe('/elsewhere');
      const sigWith = (secret: string, r: Received) =>
        `sha256=${createHmac('sha256', secret).update(`${r.headers['x-vfm-timestamp']}.${r.body}`).digest('hex')}`;
      expect(first.headers['x-vfm-signature']).toBe(sigWith(hook.secret, first));

      const rotated = (
        await call('patch', `/orgs/${orgId}/channels/${hook.id}`, { rotateSecret: true }).expect(
          200,
        )
      ).body;
      expect(rotated.secret).toMatch(/^whsec_/);
      expect(rotated.secret).not.toBe(hook.secret);
      await call('post', `/orgs/${orgId}/channels/${hook.id}/test`).expect(200);
      const second = received.at(-1) as Received;
      expect(second.headers['x-vfm-signature']).toBe(sigWith(rotated.secret, second));
      expect(second.headers['x-vfm-signature']).not.toBe(sigWith(hook.secret, second));

      const mail = (await email(call, orgId).expect(201)).body;
      await call('patch', `/orgs/${orgId}/channels/${mail.id}`, { rotateSecret: true }).expect(400);
      await call('patch', `/orgs/${orgId}/channels/${hook.id}`, {}).expect(422);
      await call('patch', `/orgs/${orgId}/channels/${hook.id}`, {
        config: { url: 'https://localhost/x' },
      }).expect(200);
    });

    it('deletes with sudo, and takes the channel out of the rules that named it', async () => {
      const { call, orgId, userId } = await org();
      const a = (await webhook(call, orgId).expect(201)).body;
      const b = (await email(call, orgId).expect(201)).body;
      const r = (await rule(call, orgId, [a.id, b.id]).expect(201)).body;

      const stale = await h.app
        .get(SessionService)
        .create({ userId, ip: '127.0.0.1', userAgent: 'v' });
      await h.app.get(SessionService).update(stale.id, { lastReauthAt: Date.now() - 10 * 60_000 });
      await h
        .api()
        .delete(`/api/v1/orgs/${orgId}/channels/${a.id}`)
        .set(
          'Cookie',
          `${SessionService.COOKIE}=${stale.id}; ${SessionService.CSRF_COOKIE}=${stale.csrfToken}`,
        )
        .set(CSRF_HEADER, stale.csrfToken)
        .expect(403);

      await call('delete', `/orgs/${orgId}/channels/${a.id}`).expect(204);
      await call('delete', `/orgs/${orgId}/channels/${a.id}`).expect(404);
      const rules = (await call('get', `/orgs/${orgId}/alerts/rules`).expect(200)).body
        .rules as any[];
      expect(rules.find((x) => x.id === r.id).channelIds).toEqual([b.id]);
    });

    it('lets a rule name only channels of its own org', async () => {
      const a = await org();
      const mine = (await email(a.call, a.orgId).expect(201)).body;
      await rule(a.call, a.orgId, [randomUUID()]).expect(400);
      const other = await h.prisma.organization.create({
        data: { id: newId(), name: 'B', slug: 'b' } as any,
      });
      const theirs = await h.prisma.inOrg(other.id, () =>
        h.prisma.notificationChannel.create({
          data: {
            id: newId(),
            orgId: other.id,
            name: 'theirs',
            type: 'EMAIL',
            configEncrypted: 'x',
          } as any,
        }),
      );
      await rule(a.call, a.orgId, [theirs.id]).expect(400);
      await rule(a.call, a.orgId, [mine.id]).expect(201);
      const r = (await rule(a.call, a.orgId, [mine.id]).expect(201)).body;
      await a
        .call('patch', `/orgs/${a.orgId}/alerts/rules/${r.id}`, { channelIds: [theirs.id] })
        .expect(400);
    });
  });

  describe('the test button', () => {
    it('sends a signed test to a webhook, a text to Slack, and a mail to every recipient', async () => {
      const { call, orgId } = await org();
      const hook = (await webhook(call, orgId).expect(201)).body;
      const chat = (await slack(call, orgId).expect(201)).body;
      const mail = (await email(call, orgId, ['a@acme.test', 'b@acme.test']).expect(201)).body;

      expect(
        (await call('post', `/orgs/${orgId}/channels/${hook.id}/test`).expect(200)).body,
      ).toEqual({ ok: true });
      const hookReq = received.at(-1) as Received;
      expect(parse(hookReq)).toMatchObject({ version: 1, kind: 'test', summary: 'Test message' });
      expect(hookReq.headers['x-vfm-kind']).toBe('test');

      expect(
        (await call('post', `/orgs/${orgId}/channels/${chat.id}/test`).expect(200)).body,
      ).toEqual({ ok: true });
      expect(parse(received.at(-1) as Received).text).toMatch(/TEST.*\nTest message/s);
      expect(received.at(-1)?.headers['x-vfm-signature']).toBeUndefined();

      expect(
        (await call('post', `/orgs/${orgId}/channels/${mail.id}/test`).expect(200)).body,
      ).toEqual({ ok: true });
      expect(h.mail.outbox.map((m) => m.to)).toEqual(['a@acme.test', 'b@acme.test']);
      expect(h.mail.outbox[0]?.subject).toMatch(/TEST/);
    });

    it('says what went wrong without the destination, and tries once', async () => {
      const { call, orgId } = await org();
      const chat = (await slack(call, orgId).expect(201)).body;
      answers['/slack'] = 500;
      const result = (await call('post', `/orgs/${orgId}/channels/${chat.id}/test`).expect(200))
        .body;
      expect(result).toEqual({ ok: false, error: 'the destination answered HTTP 500' });
      expect(received).toHaveLength(1);

      const mail = (await email(call, orgId).expect(201)).body;
      h.mail.configured = false;
      expect(
        (await call('post', `/orgs/${orgId}/channels/${mail.id}/test`).expect(200)).body.error,
      ).toMatch(/not configured/);
    });

    it('is refused for an address the policy forbids, and nothing is sent', async () => {
      const { call, orgId } = await org();
      const hook = (await webhook(call, orgId).expect(201)).body;
      channels.policy.allowPrivate = false;
      const result = (await call('post', `/orgs/${orgId}/channels/${hook.id}/test`).expect(200))
        .body;
      expect(result.ok).toBe(false);
      expect(received).toEqual([]);
    });
  });

  describe('delivery of alerts', () => {
    async function ready() {
      const o = await org();
      const hook = (await webhook(o.call, o.orgId).expect(201)).body;
      const chat = (await slack(o.call, o.orgId).expect(201)).body;
      const mail = (await email(o.call, o.orgId).expect(201)).body;
      return { ...o, hook, chat, mail };
    }

    it('tells every channel, signed, and records each delivery', async () => {
      const { call, orgId, clusterId, hook, chat, mail } = await ready();
      await rule(call, orgId, [hook.id, chat.id, mail.id]).expect(201);
      await failingBackup(orgId, clusterId);
      await engine.evaluateOrg(orgId, NOW);

      const w = received.find((r) => r.path === '/hook') as Received;
      const body = parse(w);
      expect(body).toMatchObject({
        version: 1,
        kind: 'fired',
        orgId,
        rule: { name: 'Failed backups', type: 'BACKUP_FAILED' },
        cluster: { id: clusterId, name: 'prod-eu' },
        event: { state: 'FIRING', fingerprint: 'backup-failed:velero/nightly' },
      });
      expect(body.event.payload.backup).toBe('nightly-1');
      expect(w.headers['x-vfm-event-id']).toBe(body.event.id);
      const ts = Number(w.headers['x-vfm-timestamp']);
      expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(30);
      expect(w.headers['x-vfm-signature']).toBe(
        `sha256=${createHmac('sha256', hook.secret).update(`${ts}.${w.body}`).digest('hex')}`,
      );

      const s = received.find((r) => r.path.startsWith('/slack')) as Received;
      expect(parse(s).text).toMatch(
        /\*FIRING\* Failed backups - prod-eu\nBackup nightly-1 \(schedule nightly\) Failed/,
      );
      expect(h.mail.outbox).toHaveLength(1);
      expect(h.mail.outbox[0]).toMatchObject({ to: 'ops@acme.test' });
      expect(h.mail.outbox[0]?.subject).toBe('[VFM] FIRING: Failed backups - prod-eu');

      const [event] = await events(call, orgId);
      expect(event.deliveries.map((d: any) => [d.channelName, d.kind, d.ok]).sort()).toEqual([
        ['hook', 'fired', true],
        ['mail', 'fired', true],
        ['slack', 'fired', true],
      ]);
      expect(event.lastNotifiedAt).not.toBeNull();
    });

    it('sends the resolution, and nothing more while the alert is merely still firing', async () => {
      const { call, orgId, clusterId, hook } = await ready();
      await rule(call, orgId, [hook.id]).expect(201);
      await failingBackup(orgId, clusterId);
      await engine.evaluateOrg(orgId, NOW);
      await engine.evaluateOrg(orgId, new Date(NOW.getTime() + 60_000));
      expect(received).toHaveLength(1);
      await fix(orgId, clusterId);
      await engine.evaluateOrg(orgId, NOW);
      expect(received.map((r) => parse(r).kind)).toEqual(['fired', 'resolved']);
      expect(parse(received[1] as Received).event.state).toBe('RESOLVED');
    });

    it('retries what is likely to pass, three times, and records the failure in plain words', async () => {
      const { call, orgId, clusterId, hook } = await ready();
      await rule(call, orgId, [hook.id]).expect(201);
      await failingBackup(orgId, clusterId);
      answers['/hook'] = 503;
      await engine.evaluateOrg(orgId, NOW);
      expect(received.filter((r) => r.path === '/hook')).toHaveLength(3);
      const [event] = await events(call, orgId);
      expect(event.lastNotifiedAt).toBeNull();
      expect(event.deliveries).toHaveLength(1);
      expect(event.deliveries[0]).toMatchObject({
        channelName: 'hook',
        ok: false,
        error: 'the destination answered HTTP 503',
      });
      expect(JSON.stringify(event.deliveries)).not.toContain(base);
    });

    it('does not retry what will not change, such as a 4xx', async () => {
      const { call, orgId, clusterId, hook } = await ready();
      await rule(call, orgId, [hook.id]).expect(201);
      await failingBackup(orgId, clusterId);
      answers['/hook'] = 410;
      await engine.evaluateOrg(orgId, NOW);
      expect(received).toHaveLength(1);
    });

    it('waits before offering a failed message again, then delivers it once the channel is back', async () => {
      const { call, orgId, clusterId, hook } = await ready();
      await rule(call, orgId, [hook.id]).expect(201);
      await failingBackup(orgId, clusterId);
      answers['/hook'] = 500;
      await engine.evaluateOrg(orgId, NOW);
      const attempts = received.length;

      await engine.evaluateOrg(orgId, new Date(NOW.getTime() + 60_000));
      expect(received).toHaveLength(attempts);

      answers['/hook'] = 200;
      deliveryOptions.retryAfterMs = 0;
      await engine.evaluateOrg(orgId, new Date(NOW.getTime() + 120_000));
      expect(received.at(-1)?.path).toBe('/hook');
      const [event] = await events(call, orgId);
      expect(event.lastNotifiedAt).not.toBeNull();
      expect(event.deliveries.map((d: any) => d.ok)).toEqual([false, true]);
    });

    it('counts a message as delivered when one channel took it, and does not send the others a duplicate', async () => {
      const { call, orgId, clusterId, hook, chat } = await ready();
      await rule(call, orgId, [hook.id, chat.id]).expect(201);
      await failingBackup(orgId, clusterId);
      answers['/hook'] = 400;
      await engine.evaluateOrg(orgId, NOW);
      await engine.evaluateOrg(orgId, new Date(NOW.getTime() + 60_000));
      expect(received.filter((r) => r.path.startsWith('/slack'))).toHaveLength(1);
      const [event] = await events(call, orgId);
      expect(event.lastNotifiedAt).not.toBeNull();
      expect(event.deliveries.map((d: any) => [d.channelName, d.ok]).sort()).toEqual([
        ['hook', false],
        ['slack', true],
      ]);
    });

    it('reports an email that cannot be sent, without bringing the others down', async () => {
      const { call, orgId, clusterId, hook, mail } = await ready();
      await rule(call, orgId, [hook.id, mail.id]).expect(201);
      await failingBackup(orgId, clusterId);
      h.mail.configured = false;
      await engine.evaluateOrg(orgId, NOW);
      expect(received.filter((r) => r.path === '/hook')).toHaveLength(1);
      const [event] = await events(call, orgId);
      expect(event.deliveries.find((d: any) => d.channelName === 'mail')).toMatchObject({
        ok: false,
      });
    });

    it('never sends to an address the policy forbids, even for a channel made while it was allowed', async () => {
      const { call, orgId, clusterId, hook } = await ready();
      await rule(call, orgId, [hook.id]).expect(201);
      await failingBackup(orgId, clusterId);
      channels.policy.allowPrivate = false;
      await engine.evaluateOrg(orgId, NOW);
      expect(received).toEqual([]);
      const [event] = await events(call, orgId);
      expect(event.deliveries[0].ok).toBe(false);
      expect(event.deliveries[0].error).toMatch(/not allowed/);
    });

    it('survives every channel of a rule having been deleted', async () => {
      const { call, orgId, clusterId, hook } = await ready();
      await rule(call, orgId, [hook.id]).expect(201);
      await call('delete', `/orgs/${orgId}/channels/${hook.id}`).expect(204);
      await failingBackup(orgId, clusterId);
      await expect(engine.evaluateOrg(orgId, NOW)).resolves.toMatchObject({ fired: 1 });
      expect(received).toEqual([]);
    });

    it('keeps a deleted channel’s name in the history', async () => {
      const { call, orgId, clusterId, hook } = await ready();
      await rule(call, orgId, [hook.id]).expect(201);
      await failingBackup(orgId, clusterId);
      await engine.evaluateOrg(orgId, NOW);
      await call('delete', `/orgs/${orgId}/channels/${hook.id}`).expect(204);
      const [event] = await events(call, orgId);
      expect(event.deliveries[0]).toMatchObject({ channelName: 'hook', channelId: null, ok: true });
    });

    it('never writes a destination or secret to any table but the encrypted one', async () => {
      const { call, orgId, clusterId, hook, chat } = await ready();
      await rule(call, orgId, [hook.id, chat.id]).expect(201);
      await failingBackup(orgId, clusterId);
      answers['/slack'] = 500;
      await engine.evaluateOrg(orgId, NOW);
      const tables = (
        await h.prisma.$queryRawUnsafe<{ tablename: string }[]>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
        )
      ).map((t) => t.tablename);
      for (const table of tables) {
        if (table === 'notification_channels') continue;
        const dump = JSON.stringify(await h.prisma.$queryRawUnsafe(`SELECT * FROM "${table}"`));
        expect(dump, table).not.toContain(SECRET_PATH);
        expect(dump, table).not.toContain(hook.secret);
      }
    });
  });
});
