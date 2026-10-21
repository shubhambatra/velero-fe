/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-enum-assignment, @typescript-eslint/no-unnecessary-type-assertion -- hostile messages are built untyped on purpose */
import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World } from './world';

/**
 * M7 day 37: a compromised agent, played by a seeded random generator. It sends the gateway
 * thousands of messages of every kind with hostile content: control characters, absurd sizes,
 * negative and out-of-range numbers, unknown enum values, invalid and deeply nested JSON, ids
 * that belong to another cluster. What must hold afterwards is the whole of PLAN.md §12.1's
 * "treat the agent as semi-trusted": the control plane is still up, another cluster's data and
 * commands are exactly as they were, nothing malformed was stored, and not one unhandled error
 * was logged.
 *
 * The seed is fixed so a failure reproduces; `VFM_FUZZ_SEED` and `VFM_FUZZ_ROUNDS` explore more.
 */
const SEED = Number(process.env.VFM_FUZZ_SEED ?? 20261017);
const ROUNDS = Number(process.env.VFM_FUZZ_ROUNDS ?? 1500);

/** mulberry32: small, fast, and the same on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

describe('a hostile agent (e2e, seeded)', () => {
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

  it(`leaves the control plane and every other cluster untouched (seed ${SEED}, ${ROUNDS} messages)`, async () => {
    const errors = vi.spyOn(Logger.prototype, 'error');
    const { call, orgId } = await world.admin();
    const evil = await world.agent(call, orgId, 'evil');
    const victim = await world.agent(call, orgId, 'victim');

    // The victim: connected, with inventory, and a command it has not answered.
    const victimStream = await world.connect(victim);
    victimStream.send({
      messageId: 'v',
      snapshot: {
        snapshotId: 'victim-1',
        sequence: 0,
        last: true,
        items: [resource('victim-backup', { uid: 'u-victim' })],
      },
    });
    await new Promise((r) => setTimeout(r, 400));
    const pending = (
      await call('post', `/orgs/${orgId}/clusters/${victim.clusterId}/refresh-status`).expect(202)
    ).body.id as string;

    const snapshotOfVictim = async () =>
      JSON.stringify({
        resources: await h.prisma.inOrg(orgId, () =>
          h.prisma.veleroResource.findMany({
            where: { clusterId: victim.clusterId },
            orderBy: { id: 'asc' },
          }),
        ),
        cluster: await h.prisma.inOrg(orgId, () =>
          h.prisma.cluster.findUniqueOrThrow({
            where: { id: victim.clusterId },
            select: {
              agentVersion: true,
              k8sVersion: true,
              veleroVersion: true,
              inventorySnapshotId: true,
              labels: true,
            },
          }),
        ),
        command: await h.prisma.inOrg(orgId, () =>
          h.prisma.command.findUniqueOrThrow({
            where: { id: pending },
            select: {
              status: true,
              errorCode: true,
              errorMessage: true,
              result: true,
              finishedAt: true,
            },
          }),
        ),
      });
    const before = await snapshotOfVictim();

    const rand = prng(SEED);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const HOSTILE = [
      '',
      ' ',
      'a',
      'velero',
      'default',
      '../../etc/passwd',
      '<script>alert(1)</script>',
      '\u0000',
      'a\u0000b',
      'a\nb',
      'a\r\nb',
      '‮evil',
      'ｅｖｉｌ',
      '💥',
      '__proto__',
      'constructor',
      '${jndi:ldap://x}',
      "'; DROP TABLE users;--",
      '"quoted"',
      'x'.repeat(300),
      'y'.repeat(5000),
      'z'.repeat(70_000),
      victim.clusterId,
      pending,
      'u-victim',
      'victim-backup',
      'victim-1',
    ];
    const text = (): string => (rand() < 0.15 ? `${pick(HOSTILE)}${pick(HOSTILE)}` : pick(HOSTILE));
    const num = (): number =>
      pick([0, 1, -1, 2, 7, 100, 2 ** 31 - 1, -(2 ** 31), 1e9, 255, 65_536]);
    const kind = (): number =>
      pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 99, -1]);
    const date = (): Date | undefined =>
      pick([undefined, new Date(0), new Date('2099-01-01'), new Date(), new Date('1000-01-01')]);

    const deep = (n: number): unknown =>
      n === 0 ? 'leaf' : { a: deep(n - 1), b: [deep(n - 1 > 3 ? 3 : n - 1)] };
    const json = (): Uint8Array => {
      const roll = rand();
      if (roll < 0.15) return Buffer.from('');
      if (roll < 0.3) return Buffer.from('{not json');
      if (roll < 0.4) return Buffer.from('null');
      if (roll < 0.5) return Buffer.from(JSON.stringify([1, 2, 3]));
      if (roll < 0.6) return Buffer.from(JSON.stringify(deep(int(1, 40))));
      if (roll < 0.7)
        return Buffer.from(
          JSON.stringify({
            metadata: {
              name: text(),
              namespace: text(),
              uid: text(),
              labels: Object.fromEntries(
                Array.from({ length: int(0, 120) }, () => [text().slice(0, 80), text()]),
              ),
            },
            spec: { x: 'p'.repeat(int(0, 90_000)) },
            status: { phase: text() },
          }),
        );
      if (roll < 0.8)
        return Buffer.from(
          JSON.stringify({
            __proto__: { polluted: true },
            metadata: { name: 'x', uid: 'u' },
            status: { phase: 5 },
          }),
        );
      if (roll < 0.9) return Buffer.alloc(int(0, 150_000), int(0, 255));
      return Buffer.from(
        JSON.stringify({ metadata: { name: 'ok', uid: 'u-ok' }, status: { phase: 'Completed' } }),
      );
    };
    /**
     * A valid item with one or two fields corrupted: far more likely than a fully random one to get past
     * the first checks and so test the later ones.
     */
    const hostileItem = () => {
      // The object and its claimed identity agree on a hostile name, namespace or uid: only the
      // control plane's own checks stand between that and the database.
      if (rand() < 0.35) {
        return resource(text(), {
          uid: rand() < 0.5 ? text() : `u-${int(0, 40)}`,
          namespace: rand() < 0.5 ? text() : 'velero',
          rv: text(),
          phase: text(),
          kind: kind(),
          labels: { [text().slice(0, 60)]: text() },
        }) as any;
      }
      const base: Record<string, unknown> = {
        ...resource(`fz-${int(0, 40)}`, { uid: `u-${int(0, 40)}` }),
      };
      const corrupt: Record<string, () => unknown> = {
        kind,
        namespace: text,
        name: text,
        uid: text,
        resourceVersion: text,
        creationTimestamp: date,
        objectJson: json,
      };
      for (let n = int(1, 2); n > 0; n -= 1) {
        const field = pick(Object.keys(corrupt));
        base[field] = (corrupt[field] as () => unknown)();
      }
      return base as any;
    };
    /** Half the time an item a healthy agent could send, so the deeper code paths are reached. */
    const item = () =>
      rand() < 0.5
        ? resource(`fz-${int(0, 40)}`, {
            uid: `u-${int(0, 40)}`,
            rv: String(int(1, 9)),
            phase: pick(['Completed', 'Failed', 'InProgress', text()]),
            ...(rand() < 0.3 ? { labels: { [`k${int(0, 5)}`]: text() } } : {}),
          })
        : hostileItem();
    const messageId = () => (rand() < 0.1 ? text() : `m-${int(0, 1e6)}`);

    let snapshotNo = 0;
    let applied = 'fuzz-0';
    const generators: (() => Record<string, unknown>)[] = [
      () => ({
        heartbeat: {
          sentAt: date(),
          inFlightCommands: num(),
          activeLogSessions: num(),
          bufferedEvents: num(),
        },
      }),
      () => ({ ack: { commandId: text(), state: int(-1, 9) } }),
      () => ({
        result: {
          commandId: text(),
          ok: rand() < 0.5,
          errorCode: int(-1, 40),
          errorMessage: text(),
          finishedAt: date(),
          ...(rand() < 0.3 ? { download: { bytesSent: num(), sha256Hex: text() } } : {}),
          ...(rand() < 0.3
            ? { created: { kind: kind(), namespace: text(), name: text(), uid: text() } }
            : {}),
          ...(rand() < 0.2
            ? { namespaces: { names: Array.from({ length: int(0, 3000) }, text) } }
            : {}),
        },
      }),
      // Well framed, hostile contents: the snapshot is applied, so what it holds is what gets stored.
      () => {
        snapshotNo += 1;
        applied = `fuzz-${snapshotNo}`;
        return {
          snapshot: {
            snapshotId: applied,
            sequence: 0,
            last: true,
            takenAt: date(),
            items: Array.from({ length: int(0, 25) }, item),
          },
        };
      },
      // Badly framed snapshots: wrong ids, gaps, repeats.
      () => ({
        snapshot: {
          snapshotId: rand() < 0.5 ? applied : text(),
          sequence: num(),
          last: rand() < 0.5,
          takenAt: date(),
          items: Array.from({ length: int(0, 25) }, item),
        },
      }),
      () => ({
        events: {
          snapshotId: rand() < 0.8 ? applied : text(),
          batchSequence: rand() < 0.5 ? int(0, 3) : num(),
          events: Array.from({ length: int(0, 40) }, () => ({
            type: int(-1, 6),
            item: rand() < 0.9 ? item() : undefined,
          })),
        },
      }),
      () => ({
        logChunk: {
          sessionId: rand() < 0.7 ? text() : undefined,
          commandId: rand() < 0.5 ? text() : undefined,
          sequence: num(),
          data: json(),
          eof: rand() < 0.3,
        },
      }),
      () => ({ logEnded: { sessionId: text(), reason: int(-1, 12), message: text() } }),
    ];
    // A second Hello or an empty message ends a stream by design; keep them rare so the run goes deep.
    const rare: (() => Record<string, unknown>)[] = [
      () => ({
        hello: {
          protocolVersion: num(),
          agentVersion: text(),
          clusterFingerprint: text(),
          imageTag: text(),
          chartVersion: text(),
          kubernetesVersion: text(),
        },
      }),
      () => ({}),
    ];

    let stream: OpenStream = await world.connect(evil);
    let reconnects = 0;
    const closed = async (): Promise<boolean> =>
      (await Promise.race([
        stream.ended.then(() => true),
        new Promise<boolean>((r) =>
          setTimeout(() => {
            r(false);
          }, 5),
        ),
      ])) as boolean;

    for (let i = 0; i < ROUNDS; i += 1) {
      if (await closed()) {
        reconnects += 1;
        stream = await world.connect(evil);
      }
      try {
        stream.send({
          messageId: messageId(),
          ...(rand() < 0.01 ? pick(rare)() : pick(generators)()),
        });
      } catch {
        // A message the client library itself cannot encode never reaches the wire.
      }
      if (i % 50 === 49) await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 800));
    stream.cancel();

    // 1. The control plane is up and answers.
    const ready = await h.api().get('/readyz');
    expect(ready.status, `seed ${SEED}`).toBe(200);
    await call('get', `/orgs/${orgId}/clusters`).expect(200);

    // 2. Another cluster's data and commands are exactly as they were.
    expect(await snapshotOfVictim(), `seed ${SEED}`).toBe(before);

    // 3. What was stored for the hostile cluster is well formed and bounded.
    const rows = await h.prisma.inOrg(orgId, () =>
      h.prisma.veleroResource.findMany({ where: { clusterId: evil.clusterId } }),
    );
    for (const r of rows) {
      for (const value of [r.kind, r.namespace, r.name, r.uid, r.resourceVersion, r.phase ?? '']) {
        expect(
          CONTROL.test(value),
          `a control character was stored (seed ${SEED}): ${JSON.stringify(value)}`,
        ).toBe(false);
        expect(value.length).toBeLessThanOrEqual(512);
      }
      expect(JSON.stringify(r.spec).length).toBeLessThanOrEqual(300_000);
      expect(JSON.stringify(r.status).length).toBeLessThanOrEqual(300_000);
      expect(JSON.stringify(r.labels).length).toBeLessThanOrEqual(64_000);
    }
    // Nothing leaked onto the prototype of every object in the process.
    expect(({} as any).polluted).toBeUndefined();

    // 4. Not one unhandled error was logged for any of it.
    const unhandled = errors.mock.calls.map((c) => String(c[0]));
    expect(unhandled, `seed ${SEED}`).toEqual([]);

    // 5. The test really did attack: the agent was cut off and came back more than once, and stored something.
    // The attack was real: the agent was cut off and came back, and something was accepted and stored.
    expect(reconnects).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
    errors.mockRestore();
    victimStream.cancel();
  }, 300_000);
});
