import 'reflect-metadata';

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommandAckState, type Command } from '../src/gateway/pb/vfm/agent/v1/command';
import { ErrorCode } from '../src/gateway/pb/vfm/agent/v1/common';
import { ResourceEventType, ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import type { OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Call } from './world';

/**
 * M4 day 27: the write-path golden journeys of PLAN.md §15 as the control plane sees them,
 * with a scripted agent standing in for a cluster: every request goes through the real
 * API, the real command pipeline and the real gateway; the "cluster" answers the way the
 * real agent does (acknowledge, create the object, report it in the inventory).
 *
 * What these cannot show is Velero itself doing the work (a backup that really completes, a
 * restored pod, a location that really becomes Available): that is the human checkpoint and
 * needs a real cluster (blocker B-2). Paths 1, 8, 9, 11 and 12 belong to earlier and later days.
 */
const K = ResourceKind;
const SECRET = 'AKIA-GOLDEN-MARKER-never-in-a-log';

describe('golden paths: the write operations (e2e)', () => {
  let harness: TestApp;
  let world: World;
  const logs: string[] = [];

  beforeAll(async () => {
    harness = await createTestApp({
      gateway: true,
      logTo: (line) => {
        logs.push(line);
      },
    });
    world = new World(harness);
    await world.init();
  }, 60_000);

  afterAll(async () => {
    world.close();
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    logs.length = 0;
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

  async function setup() {
    const { call, orgId, userId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await world.connect(agent);
    stream.send({
      messageId: 's',
      snapshot: { snapshotId: 's1', sequence: 0, last: true, items: [] },
    });
    await eventually(
      () =>
        harness.prisma.unscoped('t', () =>
          harness.prisma.cluster.findUniqueOrThrow({ where: { id: agent.clusterId } }),
        ),
      (c) => c.inventorySnapshotId === 's1',
    );
    let batch = 0;
    return {
      call,
      orgId,
      userId,
      agent,
      stream,
      base: `/orgs/${orgId}/clusters/${agent.clusterId}`,
      /** The cluster reports objects, as the agent's informers do. */
      report: (...items: ReturnType<typeof resource>[]) => {
        batch += 1;
        stream.send({
          messageId: `e${batch.toString()}`,
          events: {
            snapshotId: 's1',
            batchSequence: batch,
            events: items.map((item) => ({
              type: ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT,
              item,
            })),
          },
        });
      },
    };
  }

  /** The next command carrying `arm`; the agent acknowledges it and reports success. */
  async function perform(
    stream: OpenStream,
    arm: keyof Command,
    created?: { kind: string; name: string },
  ) {
    for (let i = 0; i < 8; i += 1) {
      const command = (await stream.next()).command;
      if (command?.[arm] === undefined) {
        continue;
      }
      stream.send({
        messageId: `a-${command.commandId}`,
        ack: { commandId: command.commandId, state: CommandAckState.COMMAND_ACK_STATE_RUNNING },
      });
      stream.send({
        messageId: `r-${command.commandId}`,
        result: {
          commandId: command.commandId,
          ok: true,
          ...(created === undefined ? {} : { created: { ...created, uid: `uid-${created.name}` } }),
        },
      });
      return command;
    }
    throw new Error(`no ${arm} command arrived`);
  }

  const statusOf = (call: Call, base: string, id: string) =>
    call('get', `${base}/commands/${id}`).then((r) => (r.body as { status: string }).status);

  const only = (...namespaces: string[]) => ({ type: 'NAMESPACES', namespaces });

  it('path 2: a file-system backup of one namespace completes, its logs can be read and its volume is listed', async () => {
    const s = await setup();
    const res = await s
      .call('post', `${s.base}/backups`, {
        name: 'demo-fs',
        includedNamespaces: ['demo'],
        includeClusterResources: false,
        defaultVolumesToFsBackup: true,
      })
      .expect(202);
    const command = await perform(s.stream, 'createBackup', { kind: 'Backup', name: 'demo-fs' });
    expect(command.createBackup?.spec).toMatchObject({
      includedNamespaces: ['demo'],
      defaultVolumesToFsBackup: true,
    });
    await eventually(
      () => statusOf(s.call, s.base, (res.body as { id: string }).id),
      (v) => v === 'SUCCEEDED',
    );

    // The cluster reports the backup and the volume Velero backed up with the file-system uploader.
    s.report(
      resource('demo-fs', {
        spec: { includedNamespaces: ['demo'], defaultVolumesToFsBackup: true },
      }),
      resource('demo-fs-pvb', {
        kind: K.RESOURCE_KIND_POD_VOLUME_BACKUP,
        labels: { 'velero.io/backup-name': 'demo-fs' },
        spec: { uploaderType: 'kopia' },
        status: { progress: { bytesDone: 10, totalBytes: 10 } },
      }),
    );
    const list = await eventually(
      () =>
        s
          .call('get', `${s.base}/backups`)
          .then((r) => r.body as { items: { name: string; phase: string }[] }),
      (b) => b.items.length === 1,
    );
    expect(list.items[0]).toMatchObject({ name: 'demo-fs', phase: 'Completed' });
    const detail = await s.call('get', `${s.base}/backups/demo-fs`).expect(200);
    expect(detail.body.volumes).toEqual([
      expect.objectContaining({
        kind: 'POD_VOLUME_BACKUP',
        name: 'demo-fs-pvb',
        uploader: 'kopia',
      }),
    ]);

    // Logs: ask, the agent streams the file, the control plane serves it back whole.
    const text = 'level=info msg="Backup completed" backup=demo-fs\n';
    const ask = await s.call('post', `${s.base}/backups/demo-fs/logs`).expect(202);
    let fetched: Command | undefined;
    for (let i = 0; i < 8 && fetched?.fetchDownload === undefined; i += 1) {
      fetched = (await s.stream.next()).command;
    }
    expect(ask.body).toMatchObject({ state: 'fetching' });
    const id = fetched?.commandId ?? '';
    s.stream.send({
      messageId: 'a',
      ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_RUNNING },
    });
    s.stream.send({
      messageId: 'c0',
      logChunk: { commandId: id, sequence: 0, data: Buffer.from(text), eof: false },
    });
    s.stream.send({
      messageId: 'c1',
      logChunk: { commandId: id, sequence: 1, data: Buffer.alloc(0), eof: true },
    });
    s.stream.send({
      messageId: 'r',
      result: {
        commandId: id,
        ok: true,
        download: {
          bytesSent: Buffer.byteLength(text),
          sha256Hex: createHash('sha256').update(text).digest('hex'),
        },
      },
    });
    const served = await eventually(
      async () => s.call('get', `${s.base}/backups/demo-fs/logs`),
      (r) => r.status === 200,
    );
    expect(served.text).toBe(text);
    s.stream.cancel();
  });

  it('paths 3 and 4: a restore, then a restore into a mapped namespace, each reaching the agent as asked', async () => {
    const s = await setup();
    s.report(resource('demo-fs', { spec: { includedNamespaces: ['demo'] } }));
    await eventually(
      () =>
        s
          .call('get', `${s.base}/backups`)
          .then((r) => (r.body as { items: unknown[] }).items.length),
      (n) => n === 1,
    );

    await s
      .call('post', `${s.base}/restores`, { name: 'demo-back', backupName: 'demo-fs' })
      .expect(202);
    const plain = await perform(s.stream, 'createRestore', { kind: 'Restore', name: 'demo-back' });
    expect(plain.createRestore?.spec).toMatchObject({ backupName: 'demo-fs' });

    await s
      .call('post', `${s.base}/restores`, {
        name: 'demo-copy',
        backupName: 'demo-fs',
        includedNamespaces: ['demo'],
        namespaceMapping: { demo: 'demo-restored' },
      })
      .expect(202);
    const mapped = await perform(s.stream, 'createRestore', { kind: 'Restore', name: 'demo-copy' });
    expect(mapped.createRestore?.spec).toMatchObject({
      includedNamespaces: ['demo'],
      namespaceMapping: { demo: 'demo-restored' },
    });

    s.report(
      resource('demo-back', { kind: K.RESOURCE_KIND_RESTORE, spec: { backupName: 'demo-fs' } }),
      resource('demo-copy', {
        kind: K.RESOURCE_KIND_RESTORE,
        spec: { backupName: 'demo-fs', namespaceMapping: { demo: 'demo-restored' } },
      }),
    );
    const restores = await eventually(
      () =>
        s
          .call('get', `${s.base}/restores`)
          .then((r) => r.body as { items: { name: string; phase: string }[] }),
      (b) => b.items.length === 2,
    );
    expect(restores.items.map((r) => r.phase)).toEqual(['Completed', 'Completed']);
    s.stream.cancel();
  });

  it('path 5: a schedule is created, runs, is paused and is resumed', async () => {
    const s = await setup();
    await s
      .call('post', `${s.base}/schedules`, {
        name: 'every-five',
        schedule: '*/5 * * * *',
        template: { includedNamespaces: ['demo'], includeClusterResources: false },
      })
      .expect(202);
    const created = await perform(s.stream, 'createSchedule', {
      kind: 'Schedule',
      name: 'every-five',
    });
    expect(created.createSchedule?.spec?.schedule).toBe('*/5 * * * *');

    s.report(
      resource('every-five', {
        kind: K.RESOURCE_KIND_SCHEDULE,
        spec: {
          schedule: '*/5 * * * *',
          template: { includedNamespaces: ['demo'], includeClusterResources: false },
        },
      }),
    );
    await eventually(
      () =>
        s
          .call('get', `${s.base}/schedules`)
          .then((r) => (r.body as { items: unknown[] }).items.length),
      (n) => n === 1,
    );
    await s
      .call('post', `${s.base}/schedules/every-five/trigger`, { backupName: 'every-five-1' })
      .expect(202);
    expect(
      (await perform(s.stream, 'triggerSchedule', { kind: 'Backup', name: 'every-five-1' }))
        .triggerSchedule,
    ).toMatchObject({ scheduleName: 'every-five', backupName: 'every-five-1' });

    await s.call('post', `${s.base}/schedules/every-five/pause`, { paused: true }).expect(202);
    expect((await perform(s.stream, 'setSchedulePaused')).setSchedulePaused).toMatchObject({
      name: 'every-five',
      paused: true,
    });
    s.report(
      resource('every-five', {
        kind: K.RESOURCE_KIND_SCHEDULE,
        rv: '2',
        spec: { schedule: '*/5 * * * *', paused: true, template: { includedNamespaces: ['demo'] } },
      }),
    );
    const paused = await eventually(
      () =>
        s
          .call('get', `${s.base}/schedules?paused=true`)
          .then((r) => r.body as { items: { name: string }[] }),
      (b) => b.items.length === 1,
    );
    expect(paused.items[0]?.name).toBe('every-five');

    await s.call('post', `${s.base}/schedules/every-five/pause`, { paused: false }).expect(202);
    expect((await perform(s.stream, 'setSchedulePaused')).setSchedulePaused).toMatchObject({
      paused: false,
    });
    s.stream.cancel();
  });

  it('path 6: a location with credentials is created and the credential is nowhere but at the agent', async () => {
    const s = await setup();
    const res = await s
      .call('post', `${s.base}/backup-locations`, {
        name: 'offsite',
        provider: 'aws',
        bucket: 'offsite-backups',
        config: { region: 'eu-west-1' },
        credential: { content: SECRET },
      })
      .expect(202);
    const command = await perform(s.stream, 'upsertBsl', {
      kind: 'BackupStorageLocation',
      name: 'offsite',
    });
    expect(Buffer.from(command.upsertBsl?.credential?.content ?? []).toString()).toBe(SECRET);

    s.report(
      resource('offsite', {
        kind: K.RESOURCE_KIND_BACKUP_STORAGE_LOCATION,
        phase: 'Available',
        spec: {
          provider: 'aws',
          objectStorage: { bucket: 'offsite-backups' },
          credential: { name: 'vfm-bsl-offsite', key: 'cloud' },
        },
      }),
    );
    const locations = await eventually(
      () =>
        s
          .call('get', `${s.base}/backup-locations`)
          .then((r) => r.body as { items: { phase: string }[] }),
      (b) => b.items.length === 1,
    );
    expect(locations.items[0]?.phase).toBe('Available');
    await eventually(
      () => statusOf(s.call, s.base, (res.body as { id: string }).id),
      (v) => v === 'SUCCEEDED',
    );

    // Everything a person or an operator could read afterwards.
    const reads = [
      res.body,
      (await s.call('get', `${s.base}/backup-locations`)).body,
      (await s.call('get', `${s.base}/backup-locations/offsite`)).body,
      (await s.call('get', `${s.base}/commands`)).body,
      (await s.call('get', `${s.base}/commands/${(res.body as { id: string }).id}`)).body,
      (await s.call('get', `/orgs/${s.orgId}/audit`)).body,
    ];
    for (const body of reads) {
      expect(JSON.stringify(body)).not.toContain(SECRET);
    }

    // The database, whole.
    const tables = await harness.prisma.unscoped('t', () =>
      harness.prisma.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      ),
    );
    for (const { table_name } of tables) {
      const hits = await harness.prisma.unscoped('t', () =>
        harness.prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM "${table_name}" t WHERE t::text LIKE $1`,
          `%${SECRET}%`,
        ),
      );
      expect(hits[0]?.n, `table ${table_name}`).toBe(0n);
    }

    // Every log line the control plane wrote (debug level, request and service logs), including
    // after a failed attempt that echoes the body back in no form.
    await s
      .call('post', `${s.base}/backup-locations`, {
        name: 'Bad Name',
        provider: 'aws',
        credential: { content: SECRET },
      })
      .expect(422);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(logs.join('\n')).not.toContain(Buffer.from(SECRET).toString('base64'));
    s.stream.cancel();
  });

  it('path 7: an operator limited to one namespace is refused a backup of another, of the whole cluster and of everything', async () => {
    const s = await setup();
    const email = `op-${Math.random().toString(36).slice(2, 7)}@acme.test`;
    const user = await world.member(s.call, s.orgId, email);
    await s
      .call('post', `/clusters/${s.agent.clusterId}/role-bindings`, {
        subjectType: 'USER',
        subjectId: user.userId,
        role: 'OPERATOR',
        scope: only('demo'),
      })
      .expect(201);

    const refused = [
      { includedNamespaces: ['kube-system'], includeClusterResources: false },
      { includedNamespaces: ['demo', 'kube-system'], includeClusterResources: false },
      { includedNamespaces: ['*'], includeClusterResources: false },
      { includeClusterResources: false },
      { includedNamespaces: ['demo'] },
      { includedNamespaces: ['demo'], includeClusterResources: true },
    ];
    for (const body of refused) {
      await user.call('post', `${s.base}/backups`, body).expect(403);
    }
    await user
      .call('post', `${s.base}/backups`, {
        includedNamespaces: ['demo'],
        includeClusterResources: false,
      })
      .expect(202);
    // Only the one allowed request reached the agent.
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      try {
        const c = (await s.stream.next(300)).command;
        if (c?.createBackup !== undefined) seen.push(c.commandId);
      } catch {
        break;
      }
    }
    expect(seen).toHaveLength(1);
    s.stream.cancel();
  });

  it('path 10: a read-only agent has every change disabled in the UI’s access answer, and the agent’s refusal is reported', async () => {
    const s = await setup();
    const before = (await s.call('get', `${s.base}/access`).expect(200)).body as {
      access: Record<string, string>;
      blocked: Record<string, string>;
    };
    expect(before.access['backup:create']).toBe('cluster');
    expect(before.blocked).toEqual({});

    // What the agent's Hello reports when its policy is read-only.
    await harness.prisma.unscoped('t', () =>
      harness.prisma.cluster.update({
        where: { id: s.agent.clusterId },
        data: { agentPolicy: { readOnly: true, allowRestore: true, allowBslWrite: true } },
      }),
    );
    const after = (await s.call('get', `${s.base}/access`).expect(200)).body as typeof before;
    for (const permission of [
      'backup:create',
      'restore:create',
      'schedule:write',
      'storage:write',
      'backup:delete',
    ]) {
      expect(after.access[permission], permission).toBe('none');
      expect(after.blocked[permission], permission).toMatch(/read-only/);
    }
    expect(after.access['backup:logs']).toBe('cluster');

    // A request made anyway reaches the agent, which refuses it; the refusal is the command's outcome.
    const res = await s
      .call('post', `${s.base}/backups`, {
        includedNamespaces: ['demo'],
        includeClusterResources: false,
      })
      .expect(202);
    const command = (await s.stream.next()).command;
    const id = command?.commandId ?? '';
    s.stream.send({
      messageId: 'r',
      result: {
        commandId: id,
        ok: false,
        errorCode: ErrorCode.ERROR_CODE_FORBIDDEN_BY_AGENT_POLICY,
        errorMessage: 'refused by the agent: it is read-only',
      },
    });
    const done = await eventually(
      () =>
        s
          .call('get', `${s.base}/commands/${(res.body as { id: string }).id}`)
          .then((r) => r.body as { status: string; errorCode: string }),
      (c) => c.status === 'FAILED',
    );
    expect(done.errorCode).toBe('FORBIDDEN_BY_AGENT_POLICY');
    s.stream.cancel();
  });
});
