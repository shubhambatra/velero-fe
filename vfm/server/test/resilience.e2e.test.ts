import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommandsService } from '../src/commands/commands.service';
import { CommandAckState } from '../src/gateway/pb/vfm/agent/v1/command';
import { GatewayService } from '../src/gateway/gateway.service';
import { createTestApp, TEST_DATABASE_URL, TEST_REDIS_URL, type TestApp } from './app-harness';
import { ChaosProxy } from './chaos-proxy';
import { World, type Agent, type Call } from './world';

/**
 * M7 day 39: what happens to commands when the things around the control plane fail.
 *
 * PostgreSQL, Redis and the agent link each sit behind a proxy that can be cut and restored (see
 * chaos-proxy.ts), so "restart", "outage" and "partition" are real connection resets against the real
 * services, with no root and no docker. The promises checked:
 *  - the process survives, reports itself not ready, and recovers by itself when the dependency returns;
 *  - a command is never lost (it stays in a non-terminal state until the agent finishes it or its
 *    deadline passes) and never duplicated (one row, one outcome, however many times messages repeat);
 *  - redelivery after a reconnect is at-least-once by design, and the agent can tell by the command id.
 */
const url = (u: string, port: number): string => {
  const parsed = new URL(u);
  parsed.hostname = '127.0.0.1';
  parsed.port = port.toString();
  return parsed.toString();
};
const target = (u: string) => {
  const parsed = new URL(u);
  return { host: parsed.hostname, port: Number(parsed.port) };
};

async function eventually<T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  what: string,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (ok(value)) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what} (last: ${String(last)})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('resilience (e2e)', () => {
  let pg: ChaosProxy;
  let redis: ChaosProxy;
  let link: ChaosProxy;
  let harness: TestApp;
  let world: World;
  let commands: CommandsService;
  let admin: { call: Call; userId: string; orgId: string };
  let agent: Agent;

  const stateOf = (id: string) =>
    harness.prisma.unscoped('test', () =>
      harness.prisma.command.findUniqueOrThrow({ where: { id } }),
    );
  const rows = (clusterId: string) =>
    harness.prisma.unscoped('test', () =>
      harness.prisma.command.findMany({ where: { clusterId } }),
    );
  const ready = async (): Promise<number> => (await harness.api().get('/readyz')).status;

  beforeAll(async () => {
    pg = await ChaosProxy.start(target(TEST_DATABASE_URL).host, target(TEST_DATABASE_URL).port);
    redis = await ChaosProxy.start(target(TEST_REDIS_URL).host, target(TEST_REDIS_URL).port);
    harness = await createTestApp({
      gateway: true,
      databaseUrl: url(TEST_DATABASE_URL, pg.port),
      redisUrl: url(TEST_REDIS_URL, redis.port),
    });
    world = new World(harness);
    await world.init();
    link = await ChaosProxy.start('127.0.0.1', harness.app.get(GatewayService).boundPort);
    commands = harness.app.get(CommandsService);
  }, 60_000);

  afterAll(async () => {
    pg.restore();
    redis.restore();
    world.close();
    await harness.close();
    await Promise.all([pg.close(), redis.close(), link.close()]);
  });

  beforeEach(async () => {
    pg.restore();
    redis.restore();
    link.restore();
    await harness.reset();
    admin = await world.admin();
    agent = await world.agent(admin.call, admin.orgId, 'prod-eu');
  });

  it('survives a PostgreSQL outage: not ready while down, recovers alone, and the in-flight command finishes once', async () => {
    const stream = await world.connect(agent);
    const issued = await admin
      .call('post', `/orgs/${admin.orgId}/clusters/${agent.clusterId}/refresh-status`)
      .expect(202);
    const id = (issued.body as { id: string }).id;
    expect((await stream.next()).command?.commandId).toBe(id);
    stream.send({
      messageId: 'a',
      ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
    });
    await eventually(
      () => stateOf(id),
      (s) => s.status === 'ACKED',
      'ACKED',
    );

    pg.cut();
    expect(await ready()).toBe(503);
    // A user asking for anything gets "try again", not a stack trace or a hang.
    const refused = await admin.call('get', `/orgs/${admin.orgId}/clusters`);
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBeDefined();
    expect(JSON.stringify(refused.body)).not.toMatch(/ECONN|prisma|postgres|stream/i);
    // The agent finishes the command while the database is away. The server cannot record it.
    stream.send({ messageId: 'r1', result: { commandId: id, ok: true } });
    const during = await harness.api().get('/healthz');
    expect(during.status, 'the process is still alive').toBe(200);
    pg.restore();

    await eventually(ready, (s) => s === 200, 'readyz to recover');
    // Nothing was lost: the command is still unfinished, not failed or gone.
    expect(['ACKED', 'SUCCEEDED']).toContain((await stateOf(id)).status);
    // The agent repeats its result (it was never confirmed); a repeat is harmless, twice.
    stream.send({ messageId: 'r2', result: { commandId: id, ok: true } });
    stream.send({ messageId: 'r3', result: { commandId: id, ok: true } });
    const done = await eventually(
      () => stateOf(id),
      (s) => s.status === 'SUCCEEDED',
      'SUCCEEDED',
    );
    const finished = done.finishedAt;
    stream.send({
      messageId: 'r4',
      result: { commandId: id, ok: false, errorMessage: 'late' },
    });
    await new Promise((r) => setTimeout(r, 300));
    const after = await stateOf(id);
    expect(after.status, 'a terminal command never changes').toBe('SUCCEEDED');
    expect(after.finishedAt).toEqual(finished);
    expect(await rows(agent.clusterId)).toHaveLength(1);

    // And the system is usable again for new work.
    const next = await admin
      .call('post', `/orgs/${admin.orgId}/clusters/${agent.clusterId}/refresh-status`)
      .expect(202);
    expect((await stream.next()).command?.commandId).toBe((next.body as { id: string }).id);
    stream.cancel();
  });

  it('survives a Redis outage: fails closed for users, keeps accepting agent results, and delivers queued work after', async () => {
    const stream = await world.connect(agent);
    redis.cut();
    expect(await ready()).toBe(503);
    // Sessions live in Redis. Without it nobody is let in, and nothing crashes.
    const refused = await admin.call('get', `/orgs/${admin.orgId}/clusters`);
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBeDefined();
    expect((await harness.api().get('/healthz')).status).toBe(200);

    // Work created while Redis is away is kept, not dropped.
    const queued = await commands.enqueue(
      admin.orgId,
      agent.clusterId,
      admin.userId,
      'REFRESH_STATUS',
    );
    expect((await stateOf(queued.id)).status).toMatch(/QUEUED|SENT/);

    redis.restore();
    await eventually(ready, (s) => s === 200, 'readyz to recover');
    // The agent's stream never dropped; a result sent now is applied.
    stream.send({
      messageId: 'a',
      ack: { commandId: queued.id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
    });
    await eventually(
      () => stateOf(queued.id),
      (s) => ['ACKED', 'SENT', 'QUEUED'].includes(s.status),
      'a readable command',
    );
    stream.send({ messageId: 'r', result: { commandId: queued.id, ok: true } });
    await eventually(
      () => stateOf(queued.id),
      (s) => s.status === 'SUCCEEDED',
      'SUCCEEDED',
    );
    expect(await rows(agent.clusterId)).toHaveLength(1);
    stream.cancel();
  });

  it('keeps a command through a partition between agent and server and delivers it once the agent is back', async () => {
    const first = await world.connect(agent, link.port);
    const sent = await commands.enqueue(
      admin.orgId,
      agent.clusterId,
      admin.userId,
      'REFRESH_STATUS',
    );
    expect((await first.next()).command?.commandId).toBe(sent.id);
    await eventually(
      () => stateOf(sent.id),
      (s) => s.status === 'SENT',
      'SENT',
    );

    link.cut();
    await first.ended;
    // Issued while the agent is unreachable.
    const waiting = await commands.enqueue(
      admin.orgId,
      agent.clusterId,
      admin.userId,
      'REFRESH_STATUS',
    );
    expect((await stateOf(waiting.id)).status).toBe('QUEUED');

    link.restore();
    const second = await world.connect(agent, link.port);
    // Both unfinished commands come again, each exactly once, oldest first.
    const seen: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const c = (await second.next()).command?.commandId;
      if (c !== undefined) seen.push(c);
    }
    expect(seen).toEqual([sent.id, waiting.id]);
    await expect(second.next(400)).rejects.toThrow(/timed out/);

    for (const id of seen) {
      second.send({
        messageId: `a-${id}`,
        ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
      });
      second.send({
        messageId: `a2-${id}`,
        ack: { commandId: id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
      });
      second.send({ messageId: `r-${id}`, result: { commandId: id, ok: true } });
      second.send({ messageId: `r2-${id}`, result: { commandId: id, ok: true } });
    }
    for (const id of seen)
      await eventually(
        () => stateOf(id),
        (s) => s.status === 'SUCCEEDED',
        `${id} SUCCEEDED`,
      );
    const all = await rows(agent.clusterId);
    expect(all).toHaveLength(2);
    expect(
      all.find((r) => r.id === sent.id)?.attempts,
      'the first was delivered twice, by design',
    ).toBe(2);
    expect(all.find((r) => r.id === waiting.id)?.attempts).toBe(1);
    second.cancel();
  });

  it('a slow agent holds only its own commands: another cluster is unaffected and the slow one times out', async () => {
    const other = await world.agent(admin.call, admin.orgId, 'prod-us');
    const slow = await world.connect(agent);
    const fast = await world.connect(other);

    const stuck = await commands.enqueue(
      admin.orgId,
      agent.clusterId,
      admin.userId,
      'REFRESH_STATUS',
    );
    expect((await slow.next()).command?.commandId).toBe(stuck.id);
    // The slow agent says nothing while another cluster is served promptly.
    const started = Date.now();
    const quick = await commands.enqueue(
      admin.orgId,
      other.clusterId,
      admin.userId,
      'REFRESH_STATUS',
    );
    expect((await fast.next()).command?.commandId).toBe(quick.id);
    expect(Date.now() - started).toBeLessThan(1_000);
    fast.send({
      messageId: 'a',
      ack: { commandId: quick.id, state: CommandAckState.COMMAND_ACK_STATE_ACKED },
    });
    fast.send({ messageId: 'r', result: { commandId: quick.id, ok: true } });
    await eventually(
      () => stateOf(quick.id),
      (s) => s.status === 'SUCCEEDED',
      'the other cluster to finish',
    );

    // Nothing resends the unacknowledged command on its own while the stream is up.
    await expect(slow.next(500)).rejects.toThrow(/timed out/);
    expect((await stateOf(stuck.id)).attempts).toBe(1);

    // Past its deadline it is timed out, and the agent is told to stop it.
    await harness.prisma.unscoped('test', () =>
      harness.prisma.command.update({
        where: { id: stuck.id },
        data: { deadlineAt: new Date(Date.now() - 1_000) },
      }),
    );
    await commands.sweepTimeouts();
    expect((await stateOf(stuck.id)).status).toBe('TIMED_OUT');
    // A late result from the slow agent changes nothing.
    slow.send({ messageId: 'late', result: { commandId: stuck.id, ok: true } });
    await new Promise((r) => setTimeout(r, 300));
    expect((await stateOf(stuck.id)).status).toBe('TIMED_OUT');
    slow.cancel();
    fast.cancel();
  });
});
