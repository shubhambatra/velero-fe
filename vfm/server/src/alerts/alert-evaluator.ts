import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { RedisService } from '../redis/redis.service';
import { AlertsService } from './alerts.service';

const LOCK_KEY = 'vfm:alerts:evaluator';

/**
 * Runs the engine on a timer, on one replica at a time: each tick takes a short Redis lock, and
 * a replica that does not get it skips the tick. The lock lasts a little less than the interval
 * so a replica whose timer is out of step still gets a turn.
 */
@Injectable()
export class AlertEvaluator implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AlertEvaluator.name);
  private timer: NodeJS.Timeout | undefined;
  private readonly everyMs: number;

  constructor(
    private readonly alerts: AlertsService,
    private readonly redis: RedisService,
    @Inject(ENV) env: Env,
  ) {
    this.everyMs = env.ALERT_EVAL_INTERVAL_SECONDS * 1000;
  }

  onApplicationBootstrap(): void {
    if (this.everyMs === 0) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.everyMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** One locked evaluation; false when another replica holds the turn. */
  async tick(now: Date = new Date()): Promise<boolean> {
    try {
      const lock = await this.redis.connection.set(
        LOCK_KEY,
        '1',
        'PX',
        Math.max(1000, Math.floor((this.everyMs || 30_000) * 0.8)),
        'NX',
      );
      if (lock === null) return false;
      const summary = await this.alerts.evaluateAll(now);
      if (summary.fired + summary.resolved > 0) {
        this.logger.log(
          `alerts: ${summary.fired.toString()} fired, ${summary.resolved.toString()} resolved, ${summary.renotified.toString()} repeated`,
        );
      }
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        `alert evaluation failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return false;
    }
  }
}
