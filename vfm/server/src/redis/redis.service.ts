import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Redis/Valkey client.
 *
 * Redis is a hard dependency, not a cache: PLAN.md §4.2 puts sessions in it,
 * §3.2 routes agent commands between control-plane replicas through its
 * pub/sub, and §4.2 runs BullMQ on it. A control plane that cannot reach Redis
 * cannot serve traffic, so `/readyz` must fail when it is unavailable.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    // Threat model G-13: a password is enforced when the configuration is read; transport
    // encryption is the operator's call (an in-cluster network may be trusted), so say so.
    if (env.NODE_ENV === 'production' && !env.REDIS_URL.startsWith('rediss://')) {
      this.logger.warn(
        'REDIS_URL is not rediss://: sessions and agent control messages cross the network unencrypted',
      );
    }
    this.client = new Redis(env.REDIS_URL, {
      // Fail fast rather than queueing commands forever behind a dead server;
      // readiness should flip within seconds, not minutes.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
      connectTimeout: 5_000,
    });

    this.client.on('error', (error: Error) => {
      // ioredis emits on every reconnect attempt, so a transient blip would
      // otherwise read as an outage in the logs.
      this.logger.warn(`redis connection error: ${error.message}`);
    });

    this.client.connect().catch((error: unknown) => {
      this.logger.warn(
        `initial redis connection failed, will retry: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });
  }

  /** The shared client. Pub/sub consumers must duplicate it, not reuse it. */
  get connection(): Redis {
    return this.client;
  }

  /**
   * Readiness probe (PLAN.md §10). A failure to reach Redis rejects, which is
   * what `/readyz` reports; `enableOfflineQueue: false` above is what makes
   * that happen promptly instead of queueing the command.
   */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
