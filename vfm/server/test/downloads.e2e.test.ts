import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommandAckState } from '../src/gateway/pb/vfm/agent/v1/command';
import { ErrorCode } from '../src/gateway/pb/vfm/agent/v1/common';
import { DownloadCache } from '../src/downloads/download-cache.service';
import { DownloadTargetKind } from '../src/gateway/pb/vfm/agent/v1/velero';
import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import { createTestApp, type TestApp } from './app-harness';
import type { OpenStream } from './agent-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * M3 day 20: Velero's own files for a backup or restore, fetched through the agent.
 * The agent here is a real gRPC client playing the part the Go handler plays: it
 * receives the `FetchDownload` command, sends chunks and a result. What is held:
 * a file is stored only when it arrived whole and matching its checksum, who may
 * read it follows `backup:logs` / the kind's read permission and the namespace rule,
 * a hidden backup is indistinguishable from a missing one, and one agent cannot
 * feed or read another's.
 */
const K = ResourceKind;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('backup and restore files (e2e)', () => {
  let harness: TestApp;
  let world: World;

  beforeAll(async () => {
    harness = await createTestApp({ gateway: true });
    world = new World(harness);
    await world.init();
  }, 60_000);

  afterAll(async () => {
    world.close();
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const value = await read();
      if (ok(value)) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out');
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const commandRow = (id: string) =>
    harness.prisma.unscoped('t', () => harness.prisma.command.findUniqueOrThrow({ where: { id } }));

  async function setup(items = [resource('nightly', { uid: 'uid-1' })]) {
    const { call, orgId, userId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await world.connect(agent);
    stream.send({
      messageId: 's',
      snapshot: { snapshotId: 's1', sequence: 0, last: true, items },
    });
    await eventually(
      () =>
        harness.prisma.unscoped('t', () =>
          harness.prisma.cluster.findUniqueOrThrow({ where: { id: agent.clusterId } }),
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

  /** The next FetchDownload the agent is sent. */
  async function nextFetch(stream: OpenStream) {
    for (let i = 0; i < 5; i += 1) {
      const message = await stream.next();
      if (message.command?.fetchDownload !== undefined) {
        return { id: message.command.commandId, fetch: message.command.fetchDownload };
      }
    }
    throw new Error('no FetchDownload arrived');
  }

  /** Plays the agent: ack, chunks of `text`, then the result. */
  function answer(
    stream: OpenStream,
    id: string,
    text: string,
    over: { sha?: string; bytes?: number; skipEof?: boolean; gapAt?: number; size?: number } = {},
  ) {
    stream.send({
      messageId: 'a',
      ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
    });
    stream.send({
      messageId: 'r',
      ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_RUNNING },
    });
    const size = over.size ?? 10;
    const parts = Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
      text.slice(i * size, (i + 1) * size),
    );
    parts.forEach((part, i) => {
      stream.send({
        messageId: `c${i.toString()}`,
        logChunk: {
          commandId: id,
          sequence: over.gapAt === i ? i + 5 : i,
          data: Buffer.from(part),
          eof: false,
        },
      });
    });
    if (over.skipEof !== true) {
      stream.send({
        messageId: 'e',
        logChunk: { commandId: id, sequence: parts.length, data: Buffer.alloc(0), eof: true },
      });
    }
    stream.send({
      messageId: 'res',
      result: {
        commandId: id,
        ok: true,
        download: {
          bytesSent: over.bytes ?? Buffer.byteLength(text),
          sha256Hex: over.sha ?? sha(text),
        },
      },
    });
  }

  const LOG = 'time="2026-10-16T01:00:00Z" level=info msg="Backup completed" backup=nightly\n';

  async function fetchLog(call: Call, base: string, stream: OpenStream, text = LOG) {
    const res = await call('post', `${base}/backups/nightly/logs`).expect(202);
    const { id, fetch } = await nextFetch(stream);
    expect(id).toBe(res.body.command.id);
    answer(stream, id, text);
    await eventually(
      () => commandRow(id),
      (c) => c.status === 'SUCCEEDED' || c.status === 'FAILED',
    );
    return { id, fetch };
  }

  it('fetches a backup log through the agent, stores it and serves it back', async () => {
    const { call, base, stream } = await setup();

    // Nothing held yet.
    const miss = await call('get', `${base}/backups/nightly/logs`).expect(204);
    expect(miss.headers['x-vfm-cache']).toBe('miss');

    const { id, fetch } = await fetchLog(call, base, stream);
    expect(fetch.targetKind).toBe(DownloadTargetKind.DOWNLOAD_TARGET_KIND_BACKUP_LOG);
    expect(fetch.targetName).toBe('nightly');
    expect(fetch.maxBytes).toBeGreaterThan(0);
    const row = await commandRow(id);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.result).toMatchObject({ part: 'BACKUP_LOG', bytes: Buffer.byteLength(LOG) });

    const hit = await call('get', `${base}/backups/nightly/logs`).expect(200);
    expect(hit.text).toBe(LOG);
    expect(hit.headers['content-type']).toMatch(/^text\/plain/);
    expect(hit.headers['x-content-type-options']).toBe('nosniff');
    expect(hit.headers['cache-control']).toContain('no-store');
    expect(new Date(String(hit.headers['x-vfm-fetched-at'])).getTime()).not.toBeNaN();

    const attachment = await call('get', `${base}/backups/nightly/logs?download=1`).expect(200);
    expect(attachment.headers['content-disposition']).toBe(
      'attachment; filename="nightly-logs.txt"',
    );
    stream.cancel();
  });

  it('says a fresh copy is held instead of asking the agent again, until told to refresh', async () => {
    const { call, base, stream } = await setup();
    await fetchLog(call, base, stream);

    const again = await call('post', `${base}/backups/nightly/logs`).expect(200);
    expect(again.body).toMatchObject({ state: 'cached', bytes: Buffer.byteLength(LOG) });

    const refreshed = await call('post', `${base}/backups/nightly/logs?refresh=true`).expect(202);
    expect(refreshed.body.state).toBe('fetching');
    const { id } = await nextFetch(stream);
    answer(stream, id, 'a newer log\n');
    await eventually(
      () => call('get', `${base}/backups/nightly/logs`),
      (r) => r.text === 'a newer log\n',
    );
    stream.cancel();
  });

  it('joins a fetch already in progress rather than starting a second', async () => {
    const { call, base, stream } = await setup();
    const first = await call('post', `${base}/backups/nightly/logs`).expect(202);
    const second = await call('post', `${base}/backups/nightly/logs`).expect(202);
    expect(second.body.command.id).toBe(first.body.command.id);
    stream.cancel();
  });

  it('serves detail parts of restores and backups under their own paths', async () => {
    const { call, base, stream } = await setup([
      resource('nightly', { uid: 'uid-1' }),
      resource('r1', { uid: 'uid-r', kind: K.RESOURCE_KIND_RESTORE }),
    ]);
    await call('post', `${base}/backups/nightly/details/resource-list`).expect(202);
    const first = await nextFetch(stream);
    expect(first.fetch.targetKind).toBe(
      DownloadTargetKind.DOWNLOAD_TARGET_KIND_BACKUP_RESOURCE_LIST,
    );
    answer(stream, first.id, '{"v1/Pod":["shop/a"]}');

    await call('post', `${base}/restores/r1/details/results`).expect(202);
    const second = await nextFetch(stream);
    expect(second.fetch.targetKind).toBe(DownloadTargetKind.DOWNLOAD_TARGET_KIND_RESTORE_RESULTS);
    expect(second.fetch.targetName).toBe('r1');
    answer(stream, second.id, '{"errors":{}}');

    // Each file is stored when its own command finishes; wait for both.
    await eventually(
      () => call('get', `${base}/backups/nightly/details/resource-list`),
      (r) => r.status === 200,
    );
    const results = await eventually(
      () => call('get', `${base}/restores/r1/details/results`),
      (r) => r.status === 200,
    );
    expect(results.text).toBe('{"errors":{}}');
    // A backup's file is not a restore's.
    await call('get', `${base}/restores/r1/details/resource-list`).expect(204);
    stream.cancel();
  });

  describe('a file is stored only when it arrived whole', () => {
    it.each([
      ['a wrong checksum', { sha: sha('something else') }],
      ['a wrong size', { bytes: 3 }],
      ['no end marker', { skipEof: true }],
      ['a gap in the sequence', { gapAt: 3 }],
    ])('fails the command on %s and stores nothing', async (_name, over) => {
      const { call, base, stream } = await setup();
      const text = LOG.repeat(3);
      const res = await call('post', `${base}/backups/nightly/logs`).expect(202);
      const { id } = await nextFetch(stream);
      answer(stream, id, text, over);

      const row = await eventually(
        () => commandRow(id),
        (c) => c.status === 'FAILED',
      );
      expect(row.errorMessage).toMatch(/did not arrive intact/);
      expect(res.body.command.id).toBe(id);
      await call('get', `${base}/backups/nightly/logs`).expect(204);
      stream.cancel();
    });

    it('refuses more than the limit the command asked for', async () => {
      const { call, base, stream } = await setup();
      await call('post', `${base}/backups/nightly/logs`).expect(202);
      const { id, fetch } = await nextFetch(stream);
      const text = 'x'.repeat(fetch.maxBytes + 10);
      answer(stream, id, text, { size: 64 * 1024 });
      const row = await eventually(
        () => commandRow(id),
        (c) => c.status === 'FAILED',
      );
      expect(row.errorMessage).toMatch(/limit/);
      await call('get', `${base}/backups/nightly/logs`).expect(204);
      stream.cancel();
    });

    it('fails a download whose result does not describe what was sent', async () => {
      const { call, base, stream } = await setup();
      await call('post', `${base}/backups/nightly/logs`).expect(202);
      const { id } = await nextFetch(stream);
      stream.send({ messageId: 'res', result: { commandId: id, ok: true } });
      await eventually(
        () => commandRow(id),
        (c) => c.status === 'FAILED',
      );
      stream.cancel();
    });

    it('reports the agent’s own failure as the command’s', async () => {
      const { call, base, stream } = await setup();
      await call('post', `${base}/backups/nightly/logs`).expect(202);
      const { id } = await nextFetch(stream);
      stream.send({
        messageId: 'res',
        result: {
          commandId: id,
          ok: false,
          errorCode: ErrorCode.ERROR_CODE_NOT_FOUND,
          errorMessage: 'the file is not in the object storage',
        },
      });
      const row = await eventually(
        () => commandRow(id),
        (c) => c.status === 'FAILED',
      );
      expect(row).toMatchObject({
        errorCode: 'NOT_FOUND',
        errorMessage: 'the file is not in the object storage',
      });
      stream.cancel();
    });
  });

  describe('agents are semi-trusted', () => {
    it('ignores chunks an agent sends for another cluster’s command', async () => {
      const { call, orgId, base, stream } = await setup();
      const other: Agent = await world.agent(call, orgId, 'prod-us');
      const otherStream = await world.connect(other);

      await call('post', `${base}/backups/nightly/logs`).expect(202);
      const { id } = await nextFetch(stream);

      // The other cluster's agent tries to feed this command.
      answer(otherStream, id, 'forged log\n');
      // Let the control plane take in the forged chunks before the rightful result arrives.
      await new Promise((r) => setTimeout(r, 300));
      // The rightful agent only reports success, with no data of its own.
      stream.send({
        messageId: 'res',
        result: {
          commandId: id,
          ok: true,
          download: { bytesSent: 11, sha256Hex: sha('forged log\n') },
        },
      });

      const row = await eventually(
        () => commandRow(id),
        (c) => c.status === 'FAILED',
      );
      expect(row.errorMessage).toMatch(/did not arrive intact/);
      await call('get', `${base}/backups/nightly/logs`).expect(204);
      stream.cancel();
      otherStream.cancel();
    });

    it('ignores chunks for a command that is not a download', async () => {
      const { call, base, stream } = await setup();
      const refresh = await call('post', `${base}/refresh-status`).expect(202);
      await stream.next();
      stream.send({
        messageId: 'c',
        logChunk: { commandId: refresh.body.id, sequence: 0, data: Buffer.from('x'), eof: true },
      });
      stream.send({ messageId: 'res', result: { commandId: refresh.body.id, ok: true } });
      await eventually(
        () => commandRow(refresh.body.id as string),
        (c) => c.status === 'SUCCEEDED',
      );
      stream.cancel();
    });
  });

  describe('who may read what', () => {
    async function member(call: Call, orgId: string, agent: Agent, role: string, scope: object) {
      const user = await world.member(
        call,
        orgId,
        `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 6)}@acme.test`,
      );
      await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
        subjectType: 'USER',
        subjectId: user.userId,
        role,
        scope,
      }).expect(201);
      return user;
    }

    it('keeps logs behind backup:logs while the detail parts follow backup:read', async () => {
      const { call, orgId, agent, base, stream } = await setup();
      await fetchLog(call, base, stream);
      const viewer = await member(call, orgId, agent, 'VIEWER', { type: 'CLUSTER' });
      const operator = await member(call, orgId, agent, 'OPERATOR', { type: 'CLUSTER' });

      // A viewer sees the backup but not its log.
      await viewer.call('get', `${base}/backups/nightly`).expect(200);
      await viewer.call('get', `${base}/backups/nightly/logs`).expect(403);
      await viewer.call('post', `${base}/backups/nightly/logs`).expect(403);
      await viewer.call('post', `${base}/backups/nightly/details/results`).expect(202);
      // An operator sees both.
      await operator.call('get', `${base}/backups/nightly/logs`).expect(200);
      stream.cancel();
    });

    it('cannot reach the log through the details path', async () => {
      const { call, orgId, agent, base, stream } = await setup();
      await fetchLog(call, base, stream);
      const viewer = await member(call, orgId, agent, 'VIEWER', { type: 'CLUSTER' });
      await viewer.call('get', `${base}/backups/nightly/details/logs`).expect(404);
      await viewer.call('post', `${base}/backups/nightly/details/logs`).expect(404);
      stream.cancel();
    });

    it('answers a scoped user the same for a hidden backup as for one that does not exist', async () => {
      const { call, orgId, agent, base, stream } = await setup([
        resource('prod-backup', {
          uid: 'u-p',
          spec: { storageLocation: 'default', includedNamespaces: ['prod'] },
        }),
        resource('dev-backup', {
          uid: 'u-d',
          spec: { storageLocation: 'default', includedNamespaces: ['dev'] },
        }),
      ]);
      const dev = await member(call, orgId, agent, 'OPERATOR', {
        type: 'NAMESPACES',
        namespaces: ['dev'],
      });

      for (const [method, suffix] of [
        ['get', 'logs'],
        ['post', 'logs'],
        ['get', 'details/results'],
        ['post', 'details/results'],
      ] as const) {
        const hidden = await dev.call(method, `${base}/backups/prod-backup/${suffix}`).expect(404);
        const missing = await dev.call(method, `${base}/backups/nope/${suffix}`).expect(404);
        expect(hidden.body.detail).toBe(missing.body.detail);
        expect(hidden.body.title).toBe(missing.body.title);
      }
      // What it may see, it may fetch.
      await dev.call('post', `${base}/backups/dev-backup/logs`).expect(202);
      stream.cancel();
    });

    it('honours an API token’s narrowed permissions', async () => {
      const { call, orgId, base, stream } = await setup();
      await fetchLog(call, base, stream);
      const token = (
        await call('post', `/orgs/${orgId}/tokens`, {
          name: 'narrow',
          permissions: ['cluster:read', 'backup:read'],
        }).expect(201)
      ).body.token as string;
      const as = (path: string) =>
        harness.api().get(`/api/v1${base}${path}`).set('Authorization', `Bearer ${token}`);
      await as('/backups/nightly/logs').expect(403);
      await as('/backups/nightly/details/results').expect(204);
      stream.cancel();
    });

    it('does not let another organization reach a file', async () => {
      const { call, base, stream } = await setup();
      await fetchLog(call, base, stream);
      const second = await call('post', '/orgs', { name: 'Other', slug: 'other' }).expect(201);
      await call(
        'get',
        `/orgs/${second.body.id as string}/clusters/${base.split('/')[4] ?? ''}/backups/nightly/logs`,
      ).expect(404);
      stream.cancel();
    });

    it('rejects names and parts that could be anything', async () => {
      const { call, base, stream } = await setup();
      await call('get', `${base}/backups/nightly/details/nonsense`).expect(404);
      await call('get', `${base}/backups/nightly/details/contents`).expect(404);
      await call('get', `${base}/backups/..%2Fx/logs`).expect(422);
      stream.cancel();
    });
  });

  describe('the held copy', () => {
    it('is kept for the configured days once the object has finished, and for seconds while it runs', async () => {
      const { call, base, stream } = await setup([
        resource('nightly', { uid: 'uid-1', phase: 'Completed' }),
        resource('busy', { uid: 'uid-2', phase: 'InProgress' }),
      ]);
      await fetchLog(call, base, stream);
      await call('post', `${base}/backups/busy/logs`).expect(202);
      const { id } = await nextFetch(stream);
      answer(stream, id, 'partial\n');
      await eventually(
        () => commandRow(id),
        (c) => c.status === 'SUCCEEDED',
      );

      const rows = await harness.prisma.unscoped('t', () => harness.prisma.veleroFile.findMany());
      const days = (name: string) => {
        const r = rows.find((f) => f.targetName === name);
        if (r === undefined) {
          throw new Error(`no cached file for ${name}`);
        }
        return (r.expiresAt.getTime() - r.fetchedAt.getTime()) / 86_400_000;
      };
      expect(days('nightly')).toBeCloseTo(7, 1);
      expect(days('busy') * 86_400).toBeLessThan(60);
      stream.cancel();
    });

    it('is gone once it expires, and the purge removes it', async () => {
      const { call, base, stream } = await setup();
      await fetchLog(call, base, stream);
      await harness.prisma.unscoped('t', () =>
        harness.prisma.veleroFile.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } }),
      );
      await call('get', `${base}/backups/nightly/logs`).expect(204);
      expect(await harness.app.get(DownloadCache).purge()).toBe(1);
      expect(await harness.prisma.unscoped('t', () => harness.prisma.veleroFile.count())).toBe(0);
      stream.cancel();
    });

    it('is not shown for a backup recreated under the same name', async () => {
      const { call, base, stream } = await setup();
      await fetchLog(call, base, stream);

      stream.send({
        messageId: 's2',
        snapshot: {
          snapshotId: 's2',
          sequence: 0,
          last: true,
          items: [resource('nightly', { uid: 'uid-NEW' })],
        },
      });
      await eventually(
        () => call('get', `${base}/backups/nightly`),
        (r) => r.body.summary !== undefined && r.status === 200,
      );
      await eventually(
        () => call('get', `${base}/backups/nightly/logs`),
        (r) => r.status === 204,
      );
      stream.cancel();
    });
  });

  it('is cleaned up with the cluster', async () => {
    const { call, base, agent, stream } = await setup();
    await fetchLog(call, base, stream);
    stream.cancel();
    await harness.prisma.unscoped('t', () =>
      harness.prisma.cluster.delete({ where: { id: agent.clusterId } }),
    );
    expect(await harness.prisma.unscoped('t', () => harness.prisma.veleroFile.count())).toBe(0);
  });
});
