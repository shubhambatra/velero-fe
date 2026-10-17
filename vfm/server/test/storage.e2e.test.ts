import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SessionService } from '../src/auth/session.service';
import { CommandsService } from '../src/commands/commands.service';
import { BackupStorageLocationAccessMode } from '../src/gateway/pb/vfm/agent/v1/velero';
import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import { ErrorCode } from '../src/gateway/pb/vfm/agent/v1/common';
import { CommandAckState } from '../src/gateway/pb/vfm/agent/v1/command';
import type { OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * M4 day 26: storage locations. Locations are cluster-level, so writing one needs
 * `storage:write` over the whole cluster; a credential reaches the agent and nothing else.
 */
const K = ResourceKind;

/** The credential text in these tests. It must reach the agent and be found nowhere else. */
const MARKER = 'AKIA-E2E-MARKER-must-not-leak';

describe('storage location operations (e2e)', () => {
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

  const commandRows = () =>
    harness.prisma.unscoped('t', () =>
      harness.prisma.command.findMany({ where: { op: { not: 'REFRESH_STATUS' } } }),
    );

  const bsl = (name: string, uid: string, spec: object = {}) =>
    resource(name, {
      kind: K.RESOURCE_KIND_BACKUP_STORAGE_LOCATION,
      uid,
      spec: {
        provider: 'aws',
        objectStorage: { bucket: 'backups', prefix: 'prod' },
        credential: { name: 'cloud-credentials', key: 'cloud' },
        ...spec,
      },
    });
  const vsl = (name: string, uid: string) =>
    resource(name, {
      kind: K.RESOURCE_KIND_VOLUME_SNAPSHOT_LOCATION,
      uid,
      spec: { provider: 'aws', config: { region: 'eu-west-1' } },
    });

  async function setup(
    inventory = [bsl('primary', 'u1', { default: true }), bsl('archive', 'u2'), vsl('snaps', 'u3')],
  ) {
    const { call, orgId, userId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await world.connect(agent);
    stream.send({
      messageId: 's',
      snapshot: { snapshotId: 's1', sequence: 0, last: true, items: inventory },
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

  async function member(call: Call, orgId: string, agent: Agent, role: string, scope: object) {
    const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@acme.test`;
    const user = await world.member(call, orgId, email);
    await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
      subjectType: 'USER',
      subjectId: user.userId,
      role,
      scope,
    }).expect(201);
    return user;
  }

  const whole = { type: 'CLUSTER' };
  const only = (...namespaces: string[]) => ({ type: 'NAMESPACES', namespaces });

  type Arm = 'upsertBsl' | 'setDefaultBsl' | 'deleteBsl' | 'upsertVsl' | 'deleteVsl';
  async function received<T extends Arm>(stream: OpenStream, arm: T) {
    for (let i = 0; i < 5; i += 1) {
      const command = (await stream.next()).command;
      if (command?.[arm] !== undefined) {
        return { id: command.commandId, op: command[arm] };
      }
    }
    throw new Error(`no ${arm} arrived`);
  }

  async function silent(stream: OpenStream, ms = 400) {
    try {
      const message = await stream.next(ms);
      return message.command === undefined || message.command.refreshStatus !== undefined;
    } catch {
      return true;
    }
  }

  const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

  const body = (extra: object = {}) => ({
    name: 'offsite',
    provider: 'aws',
    bucket: 'offsite-backups',
    prefix: 'prod',
    config: { region: 'eu-west-1', s3ForcePathStyle: 'true' },
    ...extra,
  });

  describe('creating a backup location', () => {
    it('sends the spec, and the credential text to the agent only', async () => {
      const s = await setup();
      const res = await s
        .call(
          'post',
          `${s.base}/backup-locations`,
          body({
            credential: { content: MARKER },
            accessMode: 'ReadOnly',
            backupSyncPeriod: '2m',
            validationFrequency: '1h',
            default: true,
          }),
        )
        .expect(202);
      expect(res.body).toMatchObject({ op: 'UPSERT_BSL' });
      expect(JSON.stringify(res.body)).not.toContain(MARKER);

      const { id, op } = await received(s.stream, 'upsertBsl');
      expect(id).toBe(res.body.id);
      expect(op.name).toBe('offsite');
      expect(op.spec).toMatchObject({
        provider: 'aws',
        config: { region: 'eu-west-1', s3ForcePathStyle: 'true' },
        credential: { name: 'vfm-bsl-offsite', key: 'cloud' },
        objectStorage: { bucket: 'offsite-backups', prefix: 'prod' },
        default: true,
        accessMode: BackupStorageLocationAccessMode.BSL_ACCESS_MODE_READ_ONLY,
        backupSyncPeriod: { seconds: 120, nanos: 0 },
        validationFrequency: { seconds: 3600, nanos: 0 },
      });
      expect(op.credential?.ref).toEqual({ name: 'vfm-bsl-offsite', key: 'cloud' });
      expect(text(op.credential?.content ?? new Uint8Array())).toBe(MARKER);
      s.stream.cancel();
    });

    it('keeps the credential out of the database, the audit trail and every response', async () => {
      const s = await setup();
      const created = await s
        .call('post', `${s.base}/backup-locations`, body({ credential: { content: MARKER } }))
        .expect(202);
      const { id } = await received(s.stream, 'upsertBsl');
      s.stream.send({
        messageId: 'a',
        ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_RUNNING },
      });
      s.stream.send({
        messageId: 'r',
        result: {
          commandId: id,
          ok: true,
          created: { kind: 'BackupStorageLocation', name: 'offsite', uid: 'x' },
        },
      });
      await eventually(commandRows, (rows) => rows.some((r) => r.status === 'SUCCEEDED'));
      await eventually(
        () => harness.prisma.unscoped('t', () => harness.prisma.auditEvent.count()),
        (n) => n >= 1,
      );

      // Every table, every column, as text.
      const tables = await harness.prisma.unscoped('t', () =>
        harness.prisma.$queryRawUnsafe<{ table_name: string }[]>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
        ),
      );
      for (const { table_name } of tables) {
        const hits = await harness.prisma.unscoped('t', () =>
          harness.prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM "${table_name}" t WHERE t::text LIKE $1`,
            `%${MARKER}%`,
          ),
        );
        expect(hits[0]?.n, `table ${table_name}`).toBe(0n);
      }

      const rows = await commandRows();
      expect(rows[0]?.payload).toMatchObject({
        name: 'offsite',
        secretRef: { name: 'vfm-bsl-offsite', key: 'cloud' },
        rotatesSecret: true,
      });
      for (const response of [
        created.body,
        (await s.call('get', `${s.base}/commands/${id}`).expect(200)).body,
        (await s.call('get', `${s.base}/backup-locations`).expect(200)).body,
      ]) {
        expect(JSON.stringify(response)).not.toContain(MARKER);
      }
      s.stream.cancel();
    });

    it('lets a location point at a Secret that already exists, with no secret material at all', async () => {
      const s = await setup();
      await s
        .call(
          'post',
          `${s.base}/backup-locations`,
          body({ credential: { secretName: 'cloud-credentials', key: 'cloud' } }),
        )
        .expect(202);
      const { op } = await received(s.stream, 'upsertBsl');
      expect(op.spec?.credential).toEqual({ name: 'cloud-credentials', key: 'cloud' });
      expect(op.credential).toBeUndefined();
      expect(
        ((await commandRows())[0]?.payload as { rotatesSecret?: boolean }).rotatesSecret,
      ).toBeUndefined();
      s.stream.cancel();
    });

    it('accepts a CA certificate', async () => {
      const s = await setup();
      const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
      await s.call('post', `${s.base}/backup-locations`, body({ caCert: pem })).expect(202);
      const { op } = await received(s.stream, 'upsertBsl');
      expect(text(op.spec?.objectStorage?.caCert ?? new Uint8Array())).toBe(pem);
      s.stream.cancel();
    });

    it.each([
      ['an unknown field', { nope: 1 }],
      ['no bucket', { bucket: undefined }],
      ['a bucket with a slash', { bucket: 'a/b' }],
      ['no provider', { provider: undefined }],
      ['a bad name', { name: 'Not_Valid' }],
      ['a setting that names a secret', { config: { region: 'x', secretAccessKey: 'abc' } }],
      ['a CA that is not a certificate', { caCert: 'hello' }],
      ['an unreadable duration', { backupSyncPeriod: 'often' }],
      ['a sync period over a week', { backupSyncPeriod: '200h' }],
      ['a credential with nothing in it', { credential: {} }],
      ['a Secret reference without a key', { credential: { secretName: 'x' } }],
      ['a credential key with a space', { credential: { content: 'x', key: 'a b' } }],
      ['an unknown credential field', { credential: { content: 'x', nope: true } }],
      ['an access mode that does not exist', { accessMode: 'WriteOnly' }],
    ])('refuses %s with 422 and sends nothing', async (_name, extra) => {
      const s = await setup();
      await s.call('post', `${s.base}/backup-locations`, body(extra)).expect(422);
      expect(await silent(s.stream)).toBe(true);
      expect(await commandRows()).toHaveLength(0);
      s.stream.cancel();
    });

    it('does not echo the credential when it refuses a request', async () => {
      const s = await setup();
      const res = await s
        .call(
          'post',
          `${s.base}/backup-locations`,
          body({ bucket: undefined, credential: { content: MARKER } }),
        )
        .expect(422);
      expect(JSON.stringify(res.body)).not.toContain(MARKER);
      s.stream.cancel();
    });

    it('answers 409 for a name that is taken', async () => {
      const s = await setup();
      await s.call('post', `${s.base}/backup-locations`, body({ name: 'primary' })).expect(409);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });
  });

  describe('changing a backup location', () => {
    it('keeps the Secret it uses and the default flag when the request says nothing of them', async () => {
      const s = await setup();
      const { name: _n, ...rest } = body({ bucket: 'moved' });
      await s.call('put', `${s.base}/backup-locations/primary`, rest).expect(202);
      const { op } = await received(s.stream, 'upsertBsl');
      expect(op.spec?.credential).toEqual({ name: 'cloud-credentials', key: 'cloud' });
      expect(op.spec?.objectStorage?.bucket).toBe('moved');
      expect(op.spec?.default).toBe(true);
      expect(op.credential).toBeUndefined();
      s.stream.cancel();
    });

    it('rotates the credential when new text is given', async () => {
      const s = await setup();
      const { name: _n, ...rest } = body({
        credential: { content: MARKER, secretName: 'cloud-credentials' },
      });
      await s.call('put', `${s.base}/backup-locations/archive`, rest).expect(202);
      const { op } = await received(s.stream, 'upsertBsl');
      expect(op.credential?.ref).toEqual({ name: 'cloud-credentials', key: 'cloud' });
      expect(text(op.credential?.content ?? new Uint8Array())).toBe(MARKER);
      s.stream.cancel();
    });

    it('answers 404 for a location that does not exist', async () => {
      const s = await setup();
      const { name: _n, ...rest } = body();
      await s.call('put', `${s.base}/backup-locations/ghost`, rest).expect(404);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });
  });

  describe('the default location', () => {
    it('can be moved to another location', async () => {
      const s = await setup();
      const res = await s.call('post', `${s.base}/backup-locations/archive/default`).expect(202);
      expect(res.body.op).toBe('SET_DEFAULT_BSL');
      expect((await received(s.stream, 'setDefaultBsl')).op.name).toBe('archive');
      s.stream.cancel();
    });

    it('answers 404 for a location that does not exist', async () => {
      const s = await setup();
      await s.call('post', `${s.base}/backup-locations/ghost/default`).expect(404);
      s.stream.cancel();
    });
  });

  describe('deleting a location', () => {
    it('asks the agent to delete a location that is not the default', async () => {
      const s = await setup();
      const res = await s.call('delete', `${s.base}/backup-locations/archive`).expect(202);
      expect(res.body.op).toBe('DELETE_BSL');
      expect((await received(s.stream, 'deleteBsl')).op.name).toBe('archive');
      s.stream.cancel();
    });

    it('refuses to delete the default while others exist', async () => {
      const s = await setup();
      const res = await s.call('delete', `${s.base}/backup-locations/primary`).expect(409);
      expect(res.body.detail).toMatch(/default/);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('lets the only location go even if it is the default', async () => {
      const s = await setup([bsl('only', 'u1', { default: true })]);
      await s.call('delete', `${s.base}/backup-locations/only`).expect(202);
      s.stream.cancel();
    });

    it('needs a recent sign-in and is not open to a token', async () => {
      const s = await setup();
      const token = (
        (await s.call('post', `/orgs/${s.orgId}/tokens`, { name: 't' }).expect(201)).body as {
          token: string;
        }
      ).token;
      await harness
        .api()
        .delete(`/api/v1${s.base}/backup-locations/archive`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      const actor = await world.actAs(s.userId);
      await harness.app
        .get(SessionService)
        .update((actor as unknown as { sessionId: string }).sessionId, {
          lastReauthAt: Date.now() - 10 * 60 * 1_000,
        });
      expect(
        (await actor('delete', `${s.base}/backup-locations/archive`).expect(403)).body.sudoRequired,
      ).toBe(true);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('answers 404 for a missing location', async () => {
      const s = await setup();
      await s.call('delete', `${s.base}/backup-locations/ghost`).expect(404);
      s.stream.cancel();
    });
  });

  describe('volume snapshot locations', () => {
    it('creates one, with a credential that stays out of the database', async () => {
      const s = await setup();
      await s
        .call('post', `${s.base}/snapshot-locations`, {
          name: 'vsl2',
          provider: 'aws',
          config: { region: 'eu-west-1' },
          credential: { content: MARKER },
        })
        .expect(202);
      const { op } = await received(s.stream, 'upsertVsl');
      expect(op.name).toBe('vsl2');
      expect(op.spec).toMatchObject({
        provider: 'aws',
        config: { region: 'eu-west-1' },
        credential: { name: 'vfm-vsl-vsl2', key: 'cloud' },
      });
      expect(text(op.credential?.content ?? new Uint8Array())).toBe(MARKER);
      expect(JSON.stringify((await commandRows())[0]?.payload)).not.toContain(MARKER);
      s.stream.cancel();
    });

    it('changes and deletes one, and refuses what does not exist or is taken', async () => {
      const s = await setup();
      await s.call('put', `${s.base}/snapshot-locations/snaps`, { provider: 'gcp' }).expect(202);
      expect((await received(s.stream, 'upsertVsl')).op.spec?.provider).toBe('gcp');
      await s.call('delete', `${s.base}/snapshot-locations/snaps`).expect(202);
      expect((await received(s.stream, 'deleteVsl')).op.name).toBe('snaps');
      await s
        .call('post', `${s.base}/snapshot-locations`, { name: 'snaps', provider: 'aws' })
        .expect(409);
      await s.call('put', `${s.base}/snapshot-locations/ghost`, { provider: 'aws' }).expect(404);
      await s.call('delete', `${s.base}/snapshot-locations/ghost`).expect(404);
      s.stream.cancel();
    });
  });

  describe('who may change storage', () => {
    it('is for cluster administrators over the whole cluster', async () => {
      const s = await setup();
      const requests: [Parameters<Call>[0], string, object?][] = [
        ['post', `${s.base}/backup-locations`, body()],
        ['put', `${s.base}/backup-locations/archive`, { provider: 'aws', bucket: 'b' }],
        ['post', `${s.base}/backup-locations/archive/default`],
        ['delete', `${s.base}/backup-locations/archive`],
        ['post', `${s.base}/snapshot-locations`, { name: 'v', provider: 'aws' }],
        ['put', `${s.base}/snapshot-locations/snaps`, { provider: 'aws' }],
        ['delete', `${s.base}/snapshot-locations/snaps`],
      ];
      const refused = [
        await member(s.call, s.orgId, s.agent, 'VIEWER', whole),
        await member(s.call, s.orgId, s.agent, 'OPERATOR', whole),
        await member(s.call, s.orgId, s.agent, 'RESTORER', whole),
        await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', only('dev')),
      ];
      for (const who of refused) {
        for (const [method, url, payload] of requests) {
          await who.call(method, url, payload).expect(403);
        }
      }
      expect(await silent(s.stream)).toBe(true);
      expect(await commandRows()).toHaveLength(0);

      const admin = await member(s.call, s.orgId, s.agent, 'CLUSTER_ADMIN', whole);
      await admin.call('post', `${s.base}/backup-locations`, body()).expect(202);
      s.stream.cancel();
    });

    it('is closed to an API token for every write, as for a delete (sudo, PLAN.md §8.3)', async () => {
      const s = await setup();
      const token = (
        (await s.call('post', `/orgs/${s.orgId}/tokens`, { name: 't' }).expect(201)).body as {
          token: string;
        }
      ).token;
      const send = (method: 'post' | 'put' | 'delete', path: string) =>
        harness
          .api()
          [method](`/api/v1${s.base}/${path}`)
          .set('Authorization', `Bearer ${token}`)
          .send(method === 'delete' ? undefined : body());
      await send('post', 'backup-locations').expect(403);
      await send('put', 'backup-locations/primary').expect(403);
      await send('post', 'backup-locations/primary/default').expect(403);
      await send('post', 'snapshot-locations').expect(403);
      await send('put', 'snapshot-locations/snaps').expect(403);
      await send('delete', 'backup-locations/primary').expect(403);
      await send('delete', 'snapshot-locations/snaps').expect(403);
      s.stream.cancel();
    });

    it('needs a recent login for every write, not only a delete', async () => {
      const s = await setup();
      const stale = await harness.app
        .get(SessionService)
        .create({ userId: s.userId, ip: '127.0.0.1', userAgent: 'v' });
      await harness.app
        .get(SessionService)
        .update(stale.id, { lastReauthAt: Date.now() - 10 * 60_000 });
      const as = (method: 'post' | 'put', path: string) =>
        harness
          .api()
          [method](`/api/v1${s.base}/${path}`)
          .set(
            'Cookie',
            `${SessionService.COOKIE}=${stale.id}; ${SessionService.CSRF_COOKIE}=${stale.csrfToken}`,
          )
          .set('x-csrf-token', stale.csrfToken)
          .send(body());
      for (const [method, path] of [
        ['post', 'backup-locations'],
        ['put', 'backup-locations/primary'],
        ['post', 'backup-locations/primary/default'],
        ['post', 'snapshot-locations'],
        ['put', 'snapshot-locations/snaps'],
      ] as const) {
        const r = await as(method, path).expect(403);
        expect(r.body.sudoRequired, path).toBe(true);
      }
      s.stream.cancel();
    });
  });

  describe('reading a location', () => {
    it('shows the spec with the reference to the Secret and no secret', async () => {
      const s = await setup();
      const res = await s.call('get', `${s.base}/backup-locations/primary`).expect(200);
      expect(res.body.summary).toMatchObject({ name: 'primary', provider: 'aws', isDefault: true });
      expect(res.body.spec.credential).toEqual({ name: 'cloud-credentials', key: 'cloud' });
      expect(res.body.yaml).toContain('kind: BackupStorageLocation');
      await s.call('get', `${s.base}/backup-locations/ghost`).expect(404);

      const snaps = await s.call('get', `${s.base}/snapshot-locations/snaps`).expect(200);
      expect(snaps.body.yaml).toContain('kind: VolumeSnapshotLocation');
      s.stream.cancel();
    });

    it('is open to a namespace-limited viewer, as the list is', async () => {
      const s = await setup();
      const scoped = await member(s.call, s.orgId, s.agent, 'VIEWER', only('dev'));
      await scoped.call('get', `${s.base}/backup-locations/primary`).expect(200);
      s.stream.cancel();
    });
  });

  describe('a credential the control plane no longer holds', () => {
    it('fails the command instead of sending a location without its credential', async () => {
      const s = await setup();
      // As after a restart: the stored payload says a credential was sent, but none is held.
      const view = await harness.app
        .get(CommandsService)
        .enqueue(s.orgId, s.agent.clusterId, s.userId, 'UPSERT_BSL', {
          name: 'offsite',
          spec: { provider: 'aws', bucket: 'b' },
          secretRef: { name: 'vfm-bsl-offsite', key: 'cloud' },
          rotatesSecret: true,
        });
      expect(view.status).toBe('FAILED');
      expect(view.errorMessage).toMatch(/submit the change again/);
      expect(await silent(s.stream)).toBe(true);
      s.stream.cancel();
    });

    it('lets go of the credential when the command finishes', async () => {
      const s = await setup();
      const held = (): number =>
        harness.app.get<{ transients: Map<string, unknown> }>(CommandsService).transients.size;
      const before = held();
      await s
        .call('post', `${s.base}/backup-locations`, body({ credential: { content: MARKER } }))
        .expect(202);
      const { id } = await received(s.stream, 'upsertBsl');
      expect(held()).toBe(before + 1);
      s.stream.send({
        messageId: 'r',
        result: {
          commandId: id,
          ok: false,
          errorCode: ErrorCode.ERROR_CODE_INVALID_ARGUMENT,
          errorMessage: 'no',
        },
      });
      await eventually(
        () => Promise.resolve(held()),
        (n) => n === before,
      );
      s.stream.cancel();
    });

    it('lets go of the credential when the command is cancelled', async () => {
      const s = await setup();
      s.stream.cancel();
      const held = (): number =>
        harness.app.get<{ transients: Map<string, unknown> }>(CommandsService).transients.size;
      const before = held();
      const res = await s
        .call('post', `${s.base}/backup-locations`, body({ credential: { content: MARKER } }))
        .expect(202);
      expect(held()).toBe(before + 1);
      await s.call('post', `${s.base}/commands/${String(res.body.id)}/cancel`).expect(200);
      expect(held()).toBe(before);
    });
  });
});
