import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ServerMessage } from '../gateway/pb/vfm/agent/v1/gateway';
import { LogSessionEndReason, type LogChunk } from '../gateway/pb/vfm/agent/v1/logs';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { WatchScopeService } from '../inventory/watch-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService, type TokenLimit } from '../rbac/rbac.service';
import { RedisService } from '../redis/redis.service';
import { StreamsService } from '../streams/streams.service';
import { logPolicyDenial } from './log-policy';
import type { StartLogSessionBody } from './log-request';
import { veleroLogTargets, type VeleroLogTargets } from './velero-pods';

/** PLAN.md §5.6. Tunable so the tests need not wait out the real windows. */
export const logOptions = {
  /** A session never runs longer than this, whoever is watching. */
  hardTimeoutMs: 30 * 60 * 1000,
  /** A session nobody is subscribed to for this long ends. */
  idleTimeoutMs: 60 * 1000,
  /** How long a session may wait for its first subscriber before it is forgotten. */
  waitingTtlMs: 60 * 1000,
  sweepMs: 5 * 1000,
  aliveTtlMs: 30 * 1000,
  /** Open sessions per person, so one user cannot occupy every slot of a cluster. */
  maxPerUser: 5,
};

/** Larger than the agent ever sends; a bigger chunk is a misbehaving agent. */
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_MESSAGE = 200;

const recordKey = (id: string): string => `vfm:logsess:${id}`;
const aliveKey = (id: string): string => `vfm:logsess:${id}:alive`;
const startedKey = (id: string): string => `vfm:logsess:${id}:started`;
const userKey = (userId: string): string => `vfm:logsess:user:${userId}`;
const clusterKey = (clusterId: string): string => `vfm:logsess:cluster:${clusterId}`;
const channel = (id: string): string => `vfm:logs:${id}`;

export interface LogSessionRecord {
  id: string;
  orgId: string;
  clusterId: string;
  userId: string;
  namespace: string;
  pod: string;
  container: string;
  tailLines: number;
  sinceSeconds: number | null;
  previous: boolean;
  timestamps: boolean;
  createdAt: string;
  /** The replica that took the request and watches for idleness. */
  owner: string;
}

/** What a subscriber is sent. */
export type LogEvent =
  | { kind: 'chunk'; sequence: number; text: string }
  | { kind: 'ended'; reason: string; message: string };

type Sink = (event: LogEvent) => void;

const REASONS: Record<number, string> = {
  [LogSessionEndReason.LOG_SESSION_END_REASON_STOPPED]: 'stopped',
  [LogSessionEndReason.LOG_SESSION_END_REASON_POD_GONE]: 'pod_gone',
  [LogSessionEndReason.LOG_SESSION_END_REASON_TIMEOUT]: 'timeout',
  [LogSessionEndReason.LOG_SESSION_END_REASON_EVICTED_BY_LIMIT]: 'evicted',
  [LogSessionEndReason.LOG_SESSION_END_REASON_DENIED_BY_POLICY]: 'denied',
  [LogSessionEndReason.LOG_SESSION_END_REASON_ERROR]: 'error',
  [LogSessionEndReason.LOG_SESSION_END_REASON_COMPLETED]: 'completed',
};

/** Text for a person, from text from a machine: no control characters, bounded. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (text: string): string => text.replace(CONTROL, ' ').trim().slice(0, MAX_MESSAGE);

/**
 * Live container logs (PLAN.md §7.2): started by a request, streamed through the agent,
 * fanned out to the browser over SSE, and **kept nowhere** — not in Postgres, not on disk,
 * and in Redis only as messages in flight on a channel nobody can read back.
 *
 * ## Shape
 * - `create` checks everything that can be checked (permission on the namespace, the
 *   agent's own policy, that the agent is connected, a per-person limit) and records the
 *   session in Redis. Nothing is asked of the agent yet.
 * - The first `attach` (the browser opening the stream) subscribes, *then* tells the agent
 *   to start, so the first lines are not lost to a subscriber that arrives late.
 * - Chunks come back on whichever replica holds the agent's stream, are decoded as UTF-8
 *   and published to `vfm:logs:{id}`; the replica holding the browser's SSE connection
 *   subscribed to that channel. The two need not be the same replica.
 *
 * ## Ending
 * By the agent (pod gone, container ended, its hard timeout, evicted by its limit), by the
 * person (`stop`, or closing every subscriber for {@link logOptions.idleTimeoutMs}), by the
 * hard timeout, or because the agent disconnected. The replica that took the request
 * watches for idleness; if it dies, the agent's own hard timeout is the backstop.
 */
@Injectable()
export class LogSessionsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LogSessionsService.name);

  /** Sessions this replica took the request for: their idle and hard-timeout watch. */
  private readonly owned = new Map<
    string,
    {
      idleSince: number | undefined;
      hardTimer: NodeJS.Timeout;
      userId: string;
      clusterId: string;
    }
  >();
  /** Browser subscribers on this replica. */
  private readonly sinks = new Map<string, Set<Sink>>();
  /** Per-session UTF-8 decoders for chunks arriving on this replica. */
  private readonly decoders = new Map<string, StringDecoder>();
  /** Recently looked-up records, so a chunk costs no Redis read. */
  private readonly known = new Map<string, { record: LogSessionRecord | null; at: number }>();
  private readonly told = new Map<string, number>();

  private subscriber: Redis | undefined;
  private sweeper: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly streams: StreamsService,
    private readonly watch: WatchScopeService,
    @Inject(ENV) env: Env,
  ) {
    logOptions.maxPerUser = env.LOG_SESSIONS_PER_USER;
  }

  onApplicationBootstrap(): void {
    const subscriber = this.redis.connection.duplicate({
      enableOfflineQueue: true,
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });
    subscriber.on('error', (error: Error) => {
      this.logger.warn(`log subscriber error: ${error.message}`);
    });
    subscriber.on('message', (name: string, payload: string) => {
      const id = name.slice('vfm:logs:'.length);
      let event: LogEvent;
      try {
        event = JSON.parse(payload) as LogEvent;
      } catch {
        return;
      }
      for (const sink of [...(this.sinks.get(id) ?? [])]) {
        try {
          sink(event);
        } catch {
          // One broken subscriber must not starve the others.
        }
      }
    });
    this.subscriber = subscriber;

    this.streams.onAgentMessage(async (clusterId, message) => {
      if (message.logChunk?.sessionId !== undefined) {
        await this.onChunk(clusterId, message.logChunk);
      } else if (message.logEnded !== undefined) {
        await this.onAgentEnded(
          clusterId,
          message.logEnded.sessionId,
          message.logEnded.reason,
          message.logEnded.message,
        );
      }
    });
    this.streams.onDisconnected(async (clusterId) => {
      await this.endCluster(clusterId);
    });

    this.scheduleSweep();
  }

  /** One timer at a time, re-reading the period so a test can shorten it. */
  private scheduleSweep(): void {
    this.sweeper = setTimeout(() => {
      this.sweep()
        .catch((error: unknown) => {
          this.logger.warn(
            `log session sweep failed: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        })
        .finally(() => {
          if (!this.stopped) {
            this.scheduleSweep();
          }
        });
    }, logOptions.sweepMs);
    this.sweeper.unref();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    clearTimeout(this.sweeper);
    for (const { hardTimer } of this.owned.values()) {
      clearTimeout(hardTimer);
    }
    this.owned.clear();
    this.sinks.clear();
    this.subscriber?.disconnect();
  }

  // --- requests ------------------------------------------------------------

  async create(
    orgId: string,
    userId: string,
    clusterId: string,
    body: StartLogSessionBody,
    token?: TokenLimit,
  ): Promise<{ sessionId: string; expiresAt: string }> {
    await this.rbac.assertClusterInOrg(orgId, clusterId);
    // Namespaced: a person who may read logs in `dev` may not in `prod`.
    await this.rbac.require(
      orgId,
      userId,
      { clusterId, permission: 'logs:read', namespaces: [body.namespace] },
      token,
    );

    const cluster = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findUnique({
        where: { id: clusterId },
        select: { status: true, agentPolicy: true },
      }),
    );
    if (cluster === null) {
      throw new NotFoundException('cluster not found');
    }
    const denial = logPolicyDenial(cluster.agentPolicy, body.namespace);
    if (denial !== undefined) {
      throw new ForbiddenException(denial);
    }
    if (cluster.status !== 'CONNECTED') {
      throw new ConflictException('the cluster’s agent is not connected');
    }
    if ((await this.openFor(userId)) >= logOptions.maxPerUser) {
      throw new HttpException(
        `you already have ${logOptions.maxPerUser.toString()} log sessions open; close one first`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const id = randomUUID();
    const record: LogSessionRecord = {
      id,
      orgId,
      clusterId,
      userId,
      namespace: body.namespace,
      pod: body.pod,
      container: body.container ?? '',
      tailLines: body.tailLines,
      sinceSeconds: body.sinceSeconds ?? null,
      previous: body.previous,
      timestamps: body.timestamps,
      createdAt: new Date().toISOString(),
      owner: this.streams.replicaId,
    };
    const redis = this.redis.connection;
    await redis.set(recordKey(id), JSON.stringify(record), 'PX', logOptions.waitingTtlMs);
    await redis.sadd(userKey(userId), id);
    await redis.pexpire(userKey(userId), logOptions.hardTimeoutMs * 2);
    await redis.sadd(clusterKey(clusterId), id);
    await redis.pexpire(clusterKey(clusterId), logOptions.hardTimeoutMs * 2);

    this.owned.set(id, {
      userId,
      clusterId,
      idleSince: Date.now(),
      hardTimer: setTimeout(() => {
        void this.finish(id, 'timeout', 'The session reached its 30 minute limit.', true);
      }, logOptions.hardTimeoutMs).unref(),
    });
    return {
      sessionId: id,
      expiresAt: new Date(Date.now() + logOptions.hardTimeoutMs).toISOString(),
    };
  }

  /** The person's own session, or 404 — the same whether it never existed or is not theirs. */
  async get(
    orgId: string,
    userId: string,
    clusterId: string,
    sessionId: string,
  ): Promise<LogSessionRecord> {
    const record = await this.load(sessionId);
    if (
      record === null ||
      record.orgId !== orgId ||
      record.clusterId !== clusterId ||
      record.userId !== userId
    ) {
      throw new NotFoundException('log session not found');
    }
    return record;
  }

  async stop(orgId: string, userId: string, clusterId: string, sessionId: string): Promise<void> {
    await this.get(orgId, userId, clusterId, sessionId);
    await this.finish(sessionId, 'stopped', '', true);
  }

  /**
   * Subscribes a browser to a session and, for the first one, starts it. Returns the
   * function that detaches. The session record is read again on every attach so a session
   * that ended in the meantime is a 404, not a stream that never speaks.
   */
  async attach(
    orgId: string,
    userId: string,
    clusterId: string,
    sessionId: string,
    sink: Sink,
  ): Promise<() => void> {
    const record = await this.get(orgId, userId, clusterId, sessionId);

    let set = this.sinks.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.sinks.set(sessionId, set);
      await this.subscriber?.subscribe(channel(sessionId));
    }
    set.add(sink);
    await this.touchAlive(sessionId);

    // Only the first subscriber of the session starts it, wherever it connects.
    const first = await this.redis.connection.set(
      startedKey(sessionId),
      '1',
      'PX',
      logOptions.hardTimeoutMs + 60_000,
      'NX',
    );
    if (first !== null) {
      await this.redis.connection.pexpire(recordKey(sessionId), logOptions.hardTimeoutMs + 60_000);
      const delivered = await this.streams.send(
        record.clusterId,
        ServerMessage.fromPartial({
          messageId: randomUUID(),
          startLogs: {
            sessionId,
            namespace: record.namespace,
            pod: record.pod,
            container: record.container,
            follow: !record.previous,
            tailLines: record.tailLines,
            sinceSeconds: record.sinceSeconds ?? 0,
            timestamps: record.timestamps,
            previous: record.previous,
          },
        }),
      );
      if (!delivered) {
        await this.finish(sessionId, 'error', 'The cluster’s agent is not connected.', false);
      }
    }

    return () => {
      const current = this.sinks.get(sessionId);
      current?.delete(sink);
      if (current !== undefined && current.size === 0) {
        this.sinks.delete(sessionId);
        this.subscriber?.unsubscribe(channel(sessionId)).catch(() => undefined);
        // Idle starts now; the owner ends the session if nobody comes back in time.
        this.redis.connection.del(aliveKey(sessionId)).catch(() => undefined);
      }
    };
  }

  /** Called while a subscriber is connected so the owner knows the session is watched. */
  async touchAlive(sessionId: string): Promise<void> {
    await this.redis.connection.set(aliveKey(sessionId), '1', 'PX', logOptions.aliveTtlMs);
  }

  /** Velero's own pods, for the “Velero server” and “node agent” shortcuts (PLAN.md §7.3). */
  async shortcuts(
    orgId: string,
    userId: string,
    clusterId: string,
    token?: TokenLimit,
  ): Promise<VeleroLogTargets & { namespace: string | null }> {
    await this.rbac.assertClusterInOrg(orgId, clusterId);
    const location = await this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.findFirst({
        where: { clusterId, kind: 'BACKUP_STORAGE_LOCATION', deletedAt: null },
        select: { namespace: true },
      }),
    );
    const namespace = location?.namespace ?? null;
    if (namespace === null || namespace === '') {
      return { namespace: null, server: [], nodeAgent: [] };
    }
    await this.rbac.require(
      orgId,
      userId,
      { clusterId, permission: 'logs:read', namespaces: [namespace] },
      token,
    );
    const cluster = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findUnique({ where: { id: clusterId }, select: { agentPolicy: true } }),
    );
    const denial = logPolicyDenial(cluster?.agentPolicy, namespace);
    if (denial !== undefined) {
      throw new ForbiddenException(denial);
    }
    // A large cluster reports pods only for namespaces someone has looked at.
    await this.watch.touch(clusterId, namespace);
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.findMany({
        where: { clusterId, kind: 'POD', namespace, deletedAt: null },
        take: 500,
      }),
    );
    return { namespace, ...veleroLogTargets(rows) };
  }

  // --- from the agent ------------------------------------------------------

  private async load(sessionId: string): Promise<LogSessionRecord | null> {
    const raw = await this.redis.connection.get(recordKey(sessionId));
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as LogSessionRecord;
    } catch {
      return null;
    }
  }

  /** Cached for a few seconds: a chunk must not cost a Redis round trip to be accepted. */
  private async recordFor(sessionId: string): Promise<LogSessionRecord | null> {
    const hit = this.known.get(sessionId);
    if (hit !== undefined && Date.now() - hit.at < 5_000) {
      return hit.record;
    }
    const record = await this.load(sessionId);
    this.known.set(sessionId, { record, at: Date.now() });
    if (this.known.size > 1000) {
      this.known.delete(this.known.keys().next().value as string);
    }
    return record;
  }

  private async onChunk(clusterId: string, chunk: LogChunk): Promise<void> {
    const id = chunk.sessionId ?? '';
    const record = await this.recordFor(id);
    if (record === null) {
      this.decoders.delete(id);
      // Nobody is waiting for this: the agent is told to stop, at most every ten seconds.
      await this.tellToStop(clusterId, id);
      return;
    }
    if (record.clusterId !== clusterId) {
      // An agent speaking for a session that is another cluster's. Dropped, not echoed.
      this.logger.warn(`cluster ${clusterId} sent a chunk for a session that is not its own`);
      return;
    }
    if (chunk.data.length > MAX_CHUNK_BYTES) {
      await this.finish(id, 'error', 'The agent sent more than a chunk may hold.', true);
      return;
    }
    let decoder = this.decoders.get(id);
    if (decoder === undefined) {
      decoder = new StringDecoder('utf8');
      this.decoders.set(id, decoder);
    }
    const text = decoder.write(Buffer.from(chunk.data));
    if (text === '') {
      return;
    }
    const event: LogEvent = { kind: 'chunk', sequence: chunk.sequence, text };
    await this.redis.connection.publish(channel(id), JSON.stringify(event));
  }

  private async onAgentEnded(
    clusterId: string,
    sessionId: string,
    reason: LogSessionEndReason,
    message: string,
  ): Promise<void> {
    const record = await this.load(sessionId);
    if (record === null || record.clusterId !== clusterId) {
      return;
    }
    await this.finish(sessionId, REASONS[reason] ?? 'error', message, false);
  }

  private async tellToStop(clusterId: string, sessionId: string): Promise<void> {
    const last = this.told.get(sessionId);
    if (last !== undefined && Date.now() - last < 10_000) {
      return;
    }
    this.told.set(sessionId, Date.now());
    if (this.told.size > 1000) {
      this.told.delete(this.told.keys().next().value as string);
    }
    await this.streams.send(
      clusterId,
      ServerMessage.fromPartial({ messageId: randomUUID(), stopLogs: { sessionId } }),
    );
  }

  /** Ends every session of a cluster whose agent has gone: there is nothing left to stream. */
  private async endCluster(clusterId: string): Promise<void> {
    const ids = await this.redis.connection.smembers(clusterKey(clusterId));
    for (const id of ids) {
      await this.finish(id, 'error', 'The cluster’s agent disconnected.', false);
    }
  }

  // --- ending --------------------------------------------------------------

  /**
   * Ends a session once, wherever it is ended from: tells the agent when asked, tells every
   * subscriber, and forgets it. Safe to call twice; the second finds nothing to end.
   */
  async finish(
    sessionId: string,
    reason: string,
    message: string,
    tellAgent: boolean,
  ): Promise<void> {
    const redis = this.redis.connection;
    const raw = await redis.get(recordKey(sessionId));
    // Whoever's DEL removes the record is the one that ends the session.
    const removed = raw === null ? 0 : await redis.del(recordKey(sessionId));
    const timers = this.owned.get(sessionId);
    if (timers !== undefined) {
      clearTimeout(timers.hardTimer);
      this.owned.delete(sessionId);
      // Even when the record is already gone (a session nobody opened expires on its own),
      // its entries in the per-person and per-cluster lists go with it.
      await redis.srem(userKey(timers.userId), sessionId);
      await redis.srem(clusterKey(timers.clusterId), sessionId);
    }
    this.decoders.delete(sessionId);
    this.known.delete(sessionId);
    if (raw === null || removed === 0) {
      return;
    }
    let record: LogSessionRecord;
    try {
      record = JSON.parse(raw) as LogSessionRecord;
    } catch {
      return;
    }
    await redis.srem(userKey(record.userId), sessionId);
    await redis.srem(clusterKey(record.clusterId), sessionId);
    await redis.del(aliveKey(sessionId), startedKey(sessionId));
    if (tellAgent) {
      await this.streams
        .send(
          record.clusterId,
          ServerMessage.fromPartial({ messageId: randomUUID(), stopLogs: { sessionId } }),
        )
        .catch(() => false);
    }
    const event: LogEvent = { kind: 'ended', reason, message: clean(message) };
    await redis.publish(channel(sessionId), JSON.stringify(event));
  }

  /** The owner's watch: ends sessions nobody is subscribed to. */
  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [id, state] of [...this.owned.entries()]) {
      const watched = (await this.redis.connection.exists(aliveKey(id))) === 1;
      if (watched) {
        state.idleSince = undefined;
        continue;
      }
      state.idleSince ??= now;
      if (now - state.idleSince >= logOptions.idleTimeoutMs) {
        await this.finish(id, 'idle', 'Closed after a minute with nobody watching.', true);
      }
    }
  }

  /** How many sessions this person has open; ones that have ended are dropped from the count. */
  private async openFor(userId: string): Promise<number> {
    const redis = this.redis.connection;
    const ids = await redis.smembers(userKey(userId));
    let open = 0;
    for (const id of ids) {
      if ((await redis.exists(recordKey(id))) === 1) {
        open += 1;
      } else {
        await redis.srem(userKey(userId), id);
      }
    }
    return open;
  }
}
