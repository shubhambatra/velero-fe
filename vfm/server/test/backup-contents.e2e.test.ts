import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { REQUIRES_SUDO } from '../src/auth/sudo.guard';
import { CommandsService } from '../src/commands/commands.service';
import { BackupContentsController } from '../src/downloads/backup-contents.controller';
import { CommandAckState } from '../src/gateway/pb/vfm/agent/v1/command';
import { ErrorCode } from '../src/gateway/pb/vfm/agent/v1/common';
import { createTestApp, type TestApp } from './app-harness';
import type { OpenStream } from './agent-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * R-055: `backup download`. The control plane never proxies backup data (P2): it hands one request a short-lived
 * signed link that the agent obtained from Velero. The link is a credential, so besides the gates
 * (organization setting, `backup:download` over every namespace, sudo) the tests pin where it is NOT: the
 * database, the audit event, a second read.
 */
const LINK =
  'https://store.example/backups/nightly/nightly.tar.gz?X-Amz-Signature=VERY-SECRET-SIGNATURE';
const soon = (): Date => new Date(Date.now() + 9 * 60_000);

describe('backup download link (e2e)', () => {
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

  async function setup(
    items = [resource('nightly', { phase: 'Completed', spec: { includedNamespaces: ['shop'] } })],
    allow = true,
  ) {
    const { call, orgId, userId } = await world.admin();
    if (allow)
      await call('patch', `/orgs/${orgId}`, { allowBackupContentDownload: true }).expect(200);
    const agent: Agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await world.connect(agent);
    stream.send({ messageId: 's', snapshot: { snapshotId: 's1', sequence: 0, last: true, items } });
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

  /** The next command the agent is sent that asks for a link. */
  async function nextLinkCommand(stream: OpenStream) {
    for (let i = 0; i < 6; i += 1) {
      const m = await stream.next();
      if (m.command?.getBackupDownloadUrl !== undefined) {
        return { id: m.command.commandId, backup: m.command.getBackupDownloadUrl.backupName };
      }
    }
    throw new Error('no GetBackupDownloadUrl arrived');
  }

  /** Plays the agent: ack, then answer with `result`. */
  function reply(stream: OpenStream, id: string, result: Record<string, unknown>) {
    stream.send({
      messageId: 'a',
      ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
    });
    stream.send({ messageId: 'r', result: { commandId: id, ...result } });
  }

  // A supertest request is lazy: it is not sent until it is awaited. These tests wait for the agent's command
  // first, so the request is started at once (a promise is eager, the request object is not).
  const post = (call: Call, base: string, name = 'nightly') =>
    call('post', `${base}/backups/${name}/download-url`, {}).then((response) => response);

  it('hands the signed link to the request that asked, and records only that one was issued', async () => {
    const { call, base, stream, orgId } = await setup();
    const pending = post(call, base);
    const cmd = await nextLinkCommand(stream);
    expect(cmd.backup).toBe('nightly');
    const expiresAt = soon();
    reply(stream, cmd.id, { ok: true, signedUrl: { url: LINK, expiresAt } });

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: LINK, expiresAt: expiresAt.toISOString() });
    expect(res.headers['cache-control']).toBe('no-store');

    // Not in the command's recorded result, its payload, or the audit trail.
    const row = await h.prisma.unscoped('t', () =>
      h.prisma.command.findUniqueOrThrow({ where: { id: cmd.id } }),
    );
    expect(JSON.stringify(row)).not.toContain('VERY-SECRET-SIGNATURE');
    expect(row.status).toBe('SUCCEEDED');
    expect(row.result).toMatchObject({ linkIssued: true });
    await eventually(
      () =>
        h.prisma.unscoped('t', () =>
          h.prisma.auditEvent.findMany({ where: { orgId, action: 'backup.download-link' } }),
        ),
      (rows) => rows.length === 1,
    ).then((rows) => {
      expect(JSON.stringify(rows)).not.toContain('VERY-SECRET-SIGNATURE');
      expect(rows[0]).toMatchObject({ outcome: 'SUCCESS', targetId: 'nightly' });
    });
    // It can be taken once: the copy in Redis is gone.
    expect(await h.app.get(CommandsService).takeSignedUrl(cmd.id)).toBeNull();
  });

  it('refuses, and sends the agent nothing, while the organization has downloads off (the default)', async () => {
    const { call, base } = await setup(undefined, false);
    // Even an organization Owner: the permission does not exist for anyone until the organization turns it on.
    const res = await post(call, base);
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/backup:download|turned off/);
    const queued = await h.prisma.unscoped('t', () =>
      h.prisma.command.count({ where: { op: 'GET_BACKUP_DOWNLOAD_URL' } }),
    );
    expect(queued).toBe(0);
  });

  it('refuses someone whose role does not include downloads', async () => {
    const { call, base, orgId, agent } = await setup();
    const operator = await world.member(call, orgId, 'op@acme.test');
    await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
      subjectType: 'USER',
      subjectId: operator.userId,
      role: 'OPERATOR',
      scope: { type: 'CLUSTER' },
    }).expect(201);
    await operator.call('post', '/me/active-org', { orgId }).expect(204);
    // An Operator can back up and read; downloading contents is Cluster Admin only.
    expect((await post(operator.call, base)).status).toBe(403);
  });

  it('needs the namespaces of the backup to be in scope, all of them', async () => {
    const both = resource('wide', {
      phase: 'Completed',
      spec: { includedNamespaces: ['shop', 'billing'] },
    });
    const shop = resource('shop-only', {
      phase: 'Completed',
      spec: { includedNamespaces: ['shop'] },
    });
    const { call, base, orgId, agent, stream } = await setup([both, shop]);
    const admin = await world.member(call, orgId, 'ns-admin@acme.test');
    await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
      subjectType: 'USER',
      subjectId: admin.userId,
      role: 'CLUSTER_ADMIN',
      scope: { type: 'NAMESPACES', namespaces: ['shop'] },
    }).expect(201);
    await admin.call('post', '/me/active-org', { orgId }).expect(204);

    expect((await post(admin.call, base, 'wide')).status).toBe(404); // reaches billing too
    const pending = post(admin.call, base, 'shop-only');
    const cmd = await nextLinkCommand(stream);
    expect(cmd.backup).toBe('shop-only');
    reply(stream, cmd.id, { ok: true, signedUrl: { url: LINK, expiresAt: soon() } });
    expect((await pending).status).toBe(200);
  });

  it('will not offer a link for a backup that has no contents yet', async () => {
    const { call, base } = await setup([
      resource('running', { phase: 'InProgress', spec: { includedNamespaces: ['shop'] } }),
    ]);
    const res = await post(call, base, 'running');
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/no contents/);
  });

  it('passes on the agent’s own refusal, and a link that is not http(s) is rejected, not forwarded', async () => {
    const { call, base, stream } = await setup();
    const denied = post(call, base);
    const first = await nextLinkCommand(stream);
    reply(stream, first.id, {
      ok: false,
      errorCode: ErrorCode.ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY,
      errorMessage: 'not on this cluster',
    });
    const refused = await denied;
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toMatch(/not on this cluster/);

    const odd = post(call, base);
    const second = await nextLinkCommand(stream);
    reply(stream, second.id, {
      ok: true,
      signedUrl: { url: 'javascript:alert(1)', expiresAt: soon() },
    });
    const bad = await odd;
    expect(bad.status).toBe(502);
    expect(JSON.stringify(bad.body)).not.toContain('javascript');
  });

  it('refuses a link whose lifetime is not short', async () => {
    const { call, base, stream } = await setup();
    const pending = post(call, base);
    const cmd = await nextLinkCommand(stream);
    reply(stream, cmd.id, {
      ok: true,
      signedUrl: { url: LINK, expiresAt: new Date(Date.now() + 24 * 3_600_000) },
    });
    expect((await pending).status).toBe(502);
  });

  it('ignores a link an agent attaches to any other command', async () => {
    const { call, base, stream } = await setup();
    const sent = await call('post', `${base}/refresh-status`, {}).expect(202);
    for (let i = 0; i < 4; i += 1) {
      const m = await stream.next();
      if (m.command?.refreshStatus !== undefined) break;
    }
    reply(stream, sent.body.id as string, {
      ok: true,
      signedUrl: { url: LINK, expiresAt: soon() },
    });
    await eventually(
      () =>
        h.prisma.unscoped('t', () =>
          h.prisma.command.findUniqueOrThrow({ where: { id: sent.body.id as string } }),
        ),
      (c) => c.status === 'SUCCEEDED',
    );
    expect(await h.app.get(CommandsService).takeSignedUrl(sent.body.id as string)).toBeNull();
  });

  it('needs the second factor window like every other deletion-grade action', () => {
    // The route is marked @RequiresSudo(); the test client re-authenticates automatically, so check the metadata.
    const handler = Object.getOwnPropertyDescriptor(BackupContentsController.prototype, 'link')
      ?.value as object;
    expect(Reflect.getMetadata(REQUIRES_SUDO, handler)).toBe(true);
  });
});
