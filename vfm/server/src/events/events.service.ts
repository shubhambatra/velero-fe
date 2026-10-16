import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { RedisService } from '../redis/redis.service';

/**
 * What the control plane tells browsers (PLAN.md §10 `/stream`).
 *
 * Deliberately **thin**: an event says that something changed on a cluster and of
 * which kind, never what the object is called or what it contains. The browser
 * then asks the REST API, which does the full permission check. That keeps the
 * fan-out channel from becoming a way to learn names a user may not see, and it
 * means the filtering rules live in one place (the REST handlers) instead of two.
 */
export type PlatformEvent =
  | { type: 'cluster'; orgId: string; clusterId: string; status: string }
  | { type: 'inventory'; orgId: string; clusterId: string; kinds: string[] }
  | { type: 'command'; orgId: string; clusterId: string; commandId: string; status: string };

type Listener = (event: PlatformEvent) => void;

const CHANNEL = 'vfm:events';

/**
 * Publishes through Redis so a change handled by one replica reaches the SSE
 * subscribers held by every other, and fans messages out to this replica's
 * subscribers in-process through a single Redis subscription.
 */
@Injectable()
export class EventsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EventsService.name);
  private readonly listeners = new Set<Listener>();
  private subscriber: Redis | undefined;

  constructor(private readonly redis: RedisService) {}

  async onApplicationBootstrap(): Promise<void> {
    const subscriber = this.redis.connection.duplicate({
      enableOfflineQueue: true,
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });
    subscriber.on('error', (error: Error) => {
      this.logger.warn(`events subscriber error: ${error.message}`);
    });
    subscriber.on('message', (_channel: string, payload: string) => {
      let event: PlatformEvent;
      try {
        event = JSON.parse(payload) as PlatformEvent;
      } catch {
        return;
      }
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (error) {
          // One broken subscriber must not starve the rest.
          this.logger.warn(
            `an event listener failed: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        }
      }
    });
    await subscriber.subscribe(CHANNEL);
    this.subscriber = subscriber;
  }

  onApplicationShutdown(): void {
    this.listeners.clear();
    this.subscriber?.disconnect();
  }

  /** Never throws: a failed notification must not fail the work it announces. */
  async publish(event: PlatformEvent): Promise<void> {
    try {
      await this.redis.connection.publish(CHANNEL, JSON.stringify(event));
    } catch (error) {
      this.logger.warn(
        `could not publish an event: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /** Subscribes; returns the function that unsubscribes. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
