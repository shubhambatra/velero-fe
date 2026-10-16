import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { ServerMessage } from '../gateway/pb/vfm/agent/v1/gateway';
import { RedisService } from '../redis/redis.service';
import { StreamsService } from '../streams/streams.service';

/** A namespace stays wanted for this long after someone last looked at its pods (PLAN.md §7.1). */
export const WATCH_WINDOW_MS = 10 * 60 * 1000;
const MAX_NAMESPACES = 200;
const SWEEP_EVERY_MS = 60 * 1000;
const key = (clusterId: string) => `vfm:watchscope:${clusterId}`;

/**
 * Which namespaces' pods the agent of a large cluster should report (PLAN.md §7.1).
 *
 * Reading the pods of a namespace marks it as wanted for ten minutes. The set lives in
 * Redis, so every replica sees the same one, and the agent is told the whole set
 * whenever it changes and when it connects. An agent of a small cluster reports every
 * pod whatever it is told, so on those this changes nothing.
 */
@Injectable()
export class WatchScopeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WatchScopeService.name);
  /** What this replica last sent, to send only changes. */
  private readonly sent = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly streams: StreamsService,
  ) {}

  onApplicationBootstrap(): void {
    this.streams.onConnected(async (clusterId) => {
      this.sent.delete(clusterId);
      await this.publish(clusterId);
    });
    this.streams.onDisconnected((clusterId) => {
      this.sent.delete(clusterId);
    });
    this.timer = setInterval(() => {
      for (const clusterId of [...this.sent.keys()]) {
        this.publish(clusterId).catch((error: unknown) => {
          this.logger.warn(
            `watch scope sweep failed: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        });
      }
    }, SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Someone is looking at the pods of `namespace`. */
  async touch(clusterId: string, namespace: string): Promise<void> {
    const now = Date.now();
    const redis = this.redis.connection;
    await redis.zadd(key(clusterId), now, namespace);
    await redis.pexpire(key(clusterId), WATCH_WINDOW_MS * 2);
    await this.publish(clusterId);
  }

  /** The namespaces wanted now, oldest interest dropped first when there are too many. */
  async wanted(clusterId: string): Promise<string[]> {
    const redis = this.redis.connection;
    await redis.zremrangebyscore(key(clusterId), '-inf', Date.now() - WATCH_WINDOW_MS);
    return redis.zrevrange(key(clusterId), 0, MAX_NAMESPACES - 1);
  }

  /** Sends the agent the set, if it is not what it was last sent. */
  async publish(clusterId: string): Promise<void> {
    const namespaces = (await this.wanted(clusterId)).sort();
    const signature = namespaces.join(',');
    if (this.sent.get(clusterId) === signature) {
      return;
    }
    // An agent starts with an empty scope, so telling a fresh one "nothing" is noise.
    if (signature === '' && !this.sent.has(clusterId)) {
      this.sent.set(clusterId, signature);
      return;
    }
    const delivered = await this.streams.send(
      clusterId,
      ServerMessage.fromPartial({
        messageId: randomUUID(),
        watchScope: { podNamespaces: namespaces },
      }),
    );
    if (delivered) {
      this.sent.set(clusterId, signature);
    }
  }
}
