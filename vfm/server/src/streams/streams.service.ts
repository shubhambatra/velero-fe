import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Readable } from 'node:stream';

import { status, type ServerDuplexStream } from '@grpc/grpc-js';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AgentMessage, ServerMessage } from '../gateway/pb/vfm/agent/v1/gateway';
import { sanitizeHello, SUPPORTED_PROTOCOL_VERSIONS, type SanitizedHello } from './hello';

/** PLAN.md §5.2 / §5.6 defaults, sent to every agent in `HelloAck`. */
const HEARTBEAT_INTERVAL_S = 15;
/** PLAN.md §13: an agent silent for this long is disconnected. */
export const RECHECK_MS = 60_000;
const DISCONNECT_AFTER_MS = 45_000;
const HELLO_TIMEOUT_MS = 10_000;
const ROUTE_TTL_S = 60;
const ROUTE_REFRESH_MS = 20_000;
const SWEEP_EVERY_MS = 30_000;
const SWEEP_LOCK_TTL_S = 25;

const ROUTE_KEY = (clusterId: string): string => `vfm:agent:${clusterId}`;
const CONTROL_CHANNEL = 'vfm:gateway:control';
const REPLICA_CHANNEL = (replicaId: string): string => `vfm:gateway:replica:${replicaId}`;
const SWEEP_LOCK_KEY = 'vfm:gateway:sweeper';

type AgentCall = ServerDuplexStream<AgentMessage, ServerMessage>;

export interface StreamIdentity {
  clusterId: string;
  orgId: string;
  serial: string;
  /** Certificate expiry; the stream is closed then so a renewed certificate takes over. */
  notAfter: Date;
}

interface LiveStream {
  sessionId: string;
  identity: StreamIdentity;
  call: AgentCall;
  /** Why the stream is being closed, set by whoever closes it first. */
  closing: { code: status; details: string } | undefined;
  connectedAt: Date;
}

interface ControlMessage {
  type: 'close';
  clusterId: string;
  reason: string;
  /** A session that must survive (the one that just superseded the others). */
  exceptSession?: string;
}

interface ForwardMessage {
  clusterId: string;
  /** base64 of an encoded `ServerMessage`. */
  message: string;
}

/** Called for every message an agent sends after Hello except heartbeats. */
export type AgentMessageHandler = (
  clusterId: string,
  message: AgentMessage,
) => void | Promise<void>;

/** Called when a stream that had been accepted has ended, for whatever reason. */
export type DisconnectedHandler = (clusterId: string, orgId: string) => void | Promise<void>;

/** Called once a stream has been accepted: the moment to re-deliver anything queued. */
export type ConnectedHandler = (clusterId: string, orgId: string) => void | Promise<void>;

/**
 * The gateway's view of connected agents: which streams this replica holds,
 * where every other replica's agents are, and the status of each cluster
 * (PLAN.md §3.2, §5.1 step 6, §16 day 13).
 *
 * ## Routing
 * `vfm:agent:{clusterId}` holds `{replica, session}` with a 60 s TTL refreshed
 * while the stream lives. Any replica can ask {@link locate} where an agent is
 * and {@link send} a message to it: locally if it holds the stream, otherwise
 * through the owning replica's channel.
 *
 * ## One stream per cluster
 * A new stream for a cluster publishes a control message that closes any other
 * stream for it (an agent that reconnected through a different replica, or a
 * second pod that got past leader election). The newest wins.
 *
 * ## Why status is not only event-driven
 * A replica that dies cannot mark its clusters disconnected. A sweeper, run by
 * whichever replica takes a short Redis lock, marks `CONNECTED` clusters whose
 * `last_seen_at` is stale and whose route has expired.
 */
@Injectable()
export class StreamsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StreamsService.name);
  readonly replicaId = `${hostname()}-${randomBytes(3).toString('hex')}`;

  /** Tunable so the tests do not have to wait 45 seconds. */
  readonly options = {
    disconnectAfterMs: DISCONNECT_AFTER_MS,
    /**
     * How often an open stream asks again whether its certificate is still good. Revocation is
     * also pushed over Redis, but a push can be lost (Redis restarting, a replica mid-deploy);
     * this is the backstop that bounds how long a revoked agent can stay connected.
     */
    recheckMs: RECHECK_MS,
  };

  private readonly streams = new Map<string, LiveStream>();
  private readonly handlers: AgentMessageHandler[] = [];
  private readonly connectedHandlers: ConnectedHandler[] = [];
  private readonly disconnectedHandlers: DisconnectedHandler[] = [];
  private subscriber: Redis | undefined;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly events: EventsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const subscriber = this.redis.connection.duplicate({
      // The shared client fails fast when offline; a subscriber must instead
      // wait and resubscribe, or a Redis blip silently ends cross-replica control.
      enableOfflineQueue: true,
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });
    subscriber.on('error', (error: Error) => {
      this.logger.warn(`redis subscriber error: ${error.message}`);
    });
    subscriber.on('message', (channel: string, payload: string) => {
      this.onChannelMessage(channel, payload);
    });
    await subscriber.subscribe(CONTROL_CHANNEL, REPLICA_CHANNEL(this.replicaId));
    this.subscriber = subscriber;

    const sweep = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.logger.warn(
          `stale-stream sweep failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
    }, SWEEP_EVERY_MS);
    const refresh = setInterval(() => {
      this.refreshRoutes().catch(() => undefined);
    }, ROUTE_REFRESH_MS);
    sweep.unref();
    refresh.unref();
    this.timers = [sweep, refresh];
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    for (const live of [...this.streams.values()]) {
      this.close(live, status.UNAVAILABLE, 'the control plane is shutting down');
    }
    this.subscriber?.disconnect();
  }

  /** Registers a handler for agent messages other than Hello and heartbeats. */
  onAgentMessage(handler: AgentMessageHandler): void {
    this.handlers.push(handler);
  }

  /** Registers a handler run after each accepted stream. Errors are logged, never fatal. */
  onConnected(handler: ConnectedHandler): void {
    this.connectedHandlers.push(handler);
  }

  /** Registers a handler run after an accepted stream ends. Errors are logged, never fatal. */
  onDisconnected(handler: DisconnectedHandler): void {
    this.disconnectedHandlers.push(handler);
  }

  /** Whether this replica holds the stream for `clusterId`. */
  isLocal(clusterId: string): boolean {
    return this.streams.has(clusterId);
  }

  /** The replica holding the agent's stream, or undefined when it is not connected. */
  async locate(clusterId: string): Promise<string | undefined> {
    const raw = await this.redis.connection.get(ROUTE_KEY(clusterId));
    if (raw === null) {
      return undefined;
    }
    try {
      return (JSON.parse(raw) as { replica: string }).replica;
    } catch {
      return undefined;
    }
  }

  /**
   * Sends a message to an agent wherever it is connected. Returns false when it
   * is not connected anywhere, so the caller can queue instead of losing it.
   */
  async send(clusterId: string, message: ServerMessage): Promise<boolean> {
    const local = this.streams.get(clusterId);
    if (local !== undefined) {
      local.call.write(message);
      return true;
    }
    const replica = await this.locate(clusterId);
    if (replica === undefined || replica === this.replicaId) {
      return false;
    }
    const forward: ForwardMessage = {
      clusterId,
      message: Buffer.from(ServerMessage.encode(message).finish()).toString('base64'),
    };
    const receivers = await this.redis.connection.publish(
      REPLICA_CHANNEL(replica),
      JSON.stringify(forward),
    );
    return receivers > 0;
  }

  /**
   * Closes every stream for a cluster on every replica: the live half of
   * revocation (PLAN.md §5.1 step 6). The deny-list stops reconnects; this ends
   * the stream that is already open.
   */
  async closeCluster(clusterId: string, reason: string): Promise<void> {
    const message: ControlMessage = { type: 'close', clusterId, reason };
    await this.redis.connection.publish(CONTROL_CHANNEL, JSON.stringify(message));
  }

  /**
   * Takes over a `Connect` call that has already authenticated: waits for Hello,
   * validates it, registers the stream, acknowledges, then serves it until it ends.
   * Resolves when the stream is finished; never throws for an agent's behaviour.
   */
  async attach(call: AgentCall, identity: StreamIdentity): Promise<void> {
    const live: LiveStream = {
      sessionId: randomUUID(),
      identity,
      call,
      closing: undefined,
      connectedAt: new Date(),
    };

    // `destroyOnReturn: false`: by default the iterator destroys the duplex when
    // the agent half-closes, which would stop us sending the closing status and
    // leave a gracefully stopping agent waiting for a reply that never comes.
    const messages = (call as unknown as Readable).iterator({
      destroyOnReturn: false,
    }) as AsyncIterator<AgentMessage>;
    let registered = false;
    let watchdog: NodeJS.Timeout | undefined;
    let expiry: NodeJS.Timeout | undefined;
    let recheck: NodeJS.Timeout | undefined;

    const arm = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        this.close(
          live,
          status.DEADLINE_EXCEEDED,
          'no message from the agent within the disconnect window',
        );
      }, this.options.disconnectAfterMs);
    };

    try {
      const hello = await this.readHello(live, messages);
      if (hello === undefined) {
        return;
      }

      await this.register(live, hello);
      registered = true;
      arm();
      this.notifyConnected(identity);

      recheck = setInterval(() => {
        this.stillAuthorized(identity)
          .then((ok) => {
            if (!ok) {
              this.close(live, status.UNAUTHENTICATED, 'the client certificate has been revoked');
            }
          })
          .catch(() => undefined);
      }, this.options.recheckMs);
      recheck.unref();

      const untilExpiry = identity.notAfter.getTime() - Date.now();
      expiry = setTimeout(
        () => {
          this.close(
            live,
            status.UNAUTHENTICATED,
            'the client certificate has expired; reconnect with the renewed one',
          );
        },
        Math.max(0, untilExpiry),
      );

      for (;;) {
        const next = await messages.next();
        if (next.done === true) {
          break;
        }
        arm();
        await this.dispatch(live, next.value);
      }
    } catch (error) {
      // A closed or aborted stream surfaces here; it is the normal way a
      // stream ends, not a fault.
      if (live.closing === undefined) {
        this.logger.debug(
          `stream for cluster ${identity.clusterId} ended: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    } finally {
      clearTimeout(watchdog);
      clearTimeout(expiry);
      clearInterval(recheck);
      if (registered) {
        await this.unregister(live).catch((error: unknown) => {
          this.logger.warn(
            `could not clean up stream for cluster ${identity.clusterId}: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        });
      }
      // End our side if nobody has yet (an agent that simply stopped sending).
      if (live.closing === undefined) {
        call.end();
      }
    }
  }

  private async readHello(
    live: LiveStream,
    messages: AsyncIterator<AgentMessage>,
  ): Promise<SanitizedHello | undefined> {
    const timer = setTimeout(() => {
      this.close(live, status.DEADLINE_EXCEEDED, 'Hello was not received in time');
    }, HELLO_TIMEOUT_MS);
    let first: IteratorResult<AgentMessage>;
    try {
      first = await messages.next();
    } finally {
      clearTimeout(timer);
    }
    if (first.done === true) {
      return undefined;
    }
    if (first.value.hello === undefined) {
      this.close(live, status.INVALID_ARGUMENT, 'the first message must be Hello');
      return undefined;
    }

    const hello = sanitizeHello(first.value.hello);
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(hello.protocolVersion)) {
      this.close(
        live,
        status.FAILED_PRECONDITION,
        `protocol version ${hello.protocolVersion.toString()} is not supported (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
      );
      return undefined;
    }

    const cluster = await this.prisma.inOrg(live.identity.orgId, () =>
      this.prisma.cluster.findUnique({
        where: { id: live.identity.clusterId },
        select: { fingerprint: true, status: true },
      }),
    );
    if (cluster === null || cluster.status === 'DISABLED') {
      this.close(live, status.UNAUTHENTICATED, 'the cluster is not enabled');
      return undefined;
    }
    if (cluster.fingerprint !== null && cluster.fingerprint !== hello.fingerprint) {
      // The same credentials are now running in a different cluster.
      this.logger.warn(`fingerprint mismatch for cluster ${live.identity.clusterId}`);
      this.close(
        live,
        status.FAILED_PRECONDITION,
        'the cluster fingerprint does not match this cluster',
      );
      return undefined;
    }
    return hello;
  }

  private async register(live: LiveStream, hello: SanitizedHello): Promise<void> {
    const { clusterId, orgId } = live.identity;

    // Newest stream wins: end any other, here or elsewhere.
    const previous = this.streams.get(clusterId);
    if (previous !== undefined) {
      this.close(previous, status.ABORTED, 'superseded by a newer connection');
    }
    this.streams.set(clusterId, live);

    await this.redis.connection.set(
      ROUTE_KEY(clusterId),
      JSON.stringify({ replica: this.replicaId, session: live.sessionId }),
      'EX',
      ROUTE_TTL_S,
    );
    const control: ControlMessage = {
      type: 'close',
      clusterId,
      reason: 'superseded by a newer connection',
      exceptSession: live.sessionId,
    };
    await this.redis.connection.publish(CONTROL_CHANNEL, JSON.stringify(control));

    await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.update({
        where: { id: clusterId },
        data: {
          status: 'CONNECTED',
          lastSeenAt: new Date(),
          k8sVersion: hello.kubernetesVersion,
          veleroVersion: hello.veleroVersion,
          veleroPlugins: hello.veleroPlugins,
          agentVersion: hello.agentVersion,
          chartVersion: hello.chartVersion,
          imageTag: hello.imageTag,
          protocolVersion: hello.protocolVersion,
          agentPolicy: hello.agentPolicy,
          capabilities: hello.capabilities,
          // The first Hello pins the fingerprint if enrollment somehow did not.
          fingerprint: hello.fingerprint === '' ? null : hello.fingerprint,
        },
      }),
    );

    live.call.write(
      ServerMessage.fromPartial({
        messageId: randomUUID(),
        helloAck: {
          acceptedProtocolVersion: hello.protocolVersion,
          serverTime: new Date(),
          config: {
            heartbeatInterval: { seconds: HEARTBEAT_INTERVAL_S, nanos: 0 },
            snapshotResyncInterval: { seconds: 600, nanos: 0 },
            maxLogSessions: 10,
            logSessionTimeout: { seconds: 1800, nanos: 0 },
            logSessionIdleTimeout: { seconds: 60, nanos: 0 },
            maxMessageBytes: 4 * 1024 * 1024,
            maxLogChunkBytes: 64 * 1024,
            maxBufferedEvents: 5000,
          },
        },
      }),
    );
    this.logger.log(`agent connected: cluster ${clusterId} on ${this.replicaId}`);
    await this.events.publish({ type: 'cluster', orgId, clusterId, status: 'CONNECTED' });
  }

  /** Whether the certificate this stream was admitted with is still valid and its cluster still enabled. A failed lookup is "yes": an outage must not disconnect every agent. */
  private async stillAuthorized(identity: StreamIdentity): Promise<boolean> {
    const row = await this.prisma.unscoped('an open stream re-checks its own certificate', () =>
      this.prisma.agentCertificate.findUnique({
        where: { serial: identity.serial },
        select: { revokedAt: true, cluster: { select: { status: true } } },
      }),
    );
    return row !== null && row.revokedAt === null && row.cluster.status !== 'DISABLED';
  }

  private notifyConnected(identity: StreamIdentity): void {
    for (const handler of this.connectedHandlers) {
      Promise.resolve(handler(identity.clusterId, identity.orgId)).catch((error: unknown) => {
        this.logger.warn(
          `a connected-handler failed for cluster ${identity.clusterId}: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
    }
  }

  private notifyDisconnected(identity: StreamIdentity): void {
    for (const handler of this.disconnectedHandlers) {
      Promise.resolve(handler(identity.clusterId, identity.orgId)).catch((error: unknown) => {
        this.logger.warn(
          `a disconnected-handler failed for cluster ${identity.clusterId}: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
    }
  }

  private async dispatch(live: LiveStream, message: AgentMessage): Promise<void> {
    if (message.heartbeat !== undefined) {
      const { clusterId, orgId } = live.identity;
      await Promise.all([
        this.redis.connection.set(
          ROUTE_KEY(clusterId),
          JSON.stringify({ replica: this.replicaId, session: live.sessionId }),
          'EX',
          ROUTE_TTL_S,
        ),
        this.prisma.inOrg(orgId, () =>
          this.prisma.cluster.updateMany({
            where: { id: clusterId },
            data: { lastSeenAt: new Date() },
          }),
        ),
      ]);
      return;
    }
    if (message.hello !== undefined) {
      // A second Hello is a protocol error, not a re-registration.
      this.close(live, status.INVALID_ARGUMENT, 'Hello may only be sent once per stream');
      return;
    }
    for (const handler of this.handlers) {
      try {
        await handler(live.identity.clusterId, message);
      } catch (error) {
        // A handler's failure is not the agent's: keep the stream.
        this.logger.warn(
          `an agent-message handler failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
  }

  private async unregister(live: LiveStream): Promise<void> {
    const { clusterId, orgId } = live.identity;
    if (this.streams.get(clusterId) === live) {
      this.streams.delete(clusterId);
      // Only the stream that was still the registered one: when a newer stream on
      // this replica has already replaced it, running these would wipe that
      // stream's state.
      this.notifyDisconnected(live.identity);
    }

    // Remove the route only if it is still ours: a newer stream on another
    // replica may already own it.
    const raw = await this.redis.connection.get(ROUTE_KEY(clusterId));
    let ownedByOther = false;
    if (raw !== null) {
      try {
        ownedByOther = (JSON.parse(raw) as { session: string }).session !== live.sessionId;
      } catch {
        ownedByOther = false;
      }
    }
    if (raw !== null && !ownedByOther) {
      await this.redis.connection.del(ROUTE_KEY(clusterId));
    }
    if (ownedByOther) {
      return;
    }

    const changed = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.updateMany({
        // Only a cluster that is still marked connected: never resurrect a
        // DISABLED one, and never overwrite a newer connection's status.
        where: { id: clusterId, status: 'CONNECTED' },
        data: { status: 'DISCONNECTED' },
      }),
    );
    this.logger.log(`agent disconnected: cluster ${clusterId}`);
    if (changed.count > 0) {
      await this.events.publish({ type: 'cluster', orgId, clusterId, status: 'DISCONNECTED' });
    }
  }

  /** Ends a stream with a gRPC status the agent can act on. Idempotent. */
  private close(live: LiveStream, code: status, details: string): void {
    if (live.closing !== undefined) {
      return;
    }
    live.closing = { code, details };
    live.call.emit('error', { code, details });
  }

  private onChannelMessage(channel: string, payload: string): void {
    try {
      if (channel === CONTROL_CHANNEL) {
        const message = JSON.parse(payload) as ControlMessage;
        const live = this.streams.get(message.clusterId);
        if (live !== undefined && live.sessionId !== message.exceptSession) {
          this.close(
            live,
            message.exceptSession === undefined ? status.PERMISSION_DENIED : status.ABORTED,
            message.reason,
          );
        }
        return;
      }
      const forward = JSON.parse(payload) as ForwardMessage;
      const live = this.streams.get(forward.clusterId);
      if (live !== undefined) {
        live.call.write(ServerMessage.decode(Buffer.from(forward.message, 'base64')));
      }
    } catch (error) {
      this.logger.warn(
        `ignored a malformed gateway message: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /** Keeps this replica's routes alive between heartbeats. */
  private async refreshRoutes(): Promise<void> {
    await Promise.all(
      [...this.streams.values()].map((live) =>
        this.redis.connection.expire(ROUTE_KEY(live.identity.clusterId), ROUTE_TTL_S),
      ),
    );
  }

  /**
   * Marks clusters whose agent has gone silent without a clean close (the
   * replica holding the stream died). One replica at a time, by lock.
   */
  async sweep(): Promise<number> {
    const lock = await this.redis.connection.set(
      SWEEP_LOCK_KEY,
      this.replicaId,
      'EX',
      SWEEP_LOCK_TTL_S,
      'NX',
    );
    if (lock === null) {
      return 0;
    }
    const cutoff = new Date(Date.now() - this.options.disconnectAfterMs);
    const stale = await this.prisma.unscoped('the stale-stream sweeper spans every org', () =>
      this.prisma.cluster.findMany({
        where: { status: 'CONNECTED', lastSeenAt: { lt: cutoff } },
        select: { id: true, orgId: true },
      }),
    );

    let marked = 0;
    for (const cluster of stale) {
      if ((await this.redis.connection.exists(ROUTE_KEY(cluster.id))) === 1) {
        continue;
      }
      const result = await this.prisma.inOrg(cluster.orgId, () =>
        this.prisma.cluster.updateMany({
          where: { id: cluster.id, status: 'CONNECTED', lastSeenAt: { lt: cutoff } },
          data: { status: 'DISCONNECTED' },
        }),
      );
      marked += result.count;
      if (result.count > 0) {
        await this.events.publish({
          type: 'cluster',
          orgId: cluster.orgId,
          clusterId: cluster.id,
          status: 'DISCONNECTED',
        });
      }
    }
    return marked;
  }
}

/** Convenience for the gateway: only what it needs from a decoded message. */
export type { AgentMessage };
