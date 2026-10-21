import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { RedisService } from '../redis/redis.service';
import { ThrottledException } from './throttled.exception';
import { rateLimited } from '../metrics/metrics';

const RATE_LIMIT = 'vfm:rateLimit';

export interface RateRule {
  /** Names the counter; routes that share a name share a budget. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** `user` counts per signed-in person and falls back to the address; `ip` always counts per address. */
  by: 'ip' | 'user';
}

/**
 * Limits how often one caller may reach a route (PLAN.md §12.1, threat model G-3). For the
 * routes anyone can call (setup, registration, the start of a single sign-on) and for the ones
 * that cost something (reports, exports, opening a live stream, a test message).
 *
 * The login and second-factor paths have their own, stricter counters that also remember
 * failures; this is the blunt backstop for everything else.
 */
export const RateLimit = (
  name: string,
  limit: number,
  windowSeconds: number,
  by: 'ip' | 'user' = 'user',
): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT, { name, limit, windowSeconds, by } satisfies RateRule);

/**
 * A fixed window per route name and caller in Redis, so the limit holds across replicas. It runs
 * after the session guard, which is what lets it count signed-in people by identity rather than
 * by the address they share with everyone behind the same proxy. A Redis failure lets the
 * request through and says so: refusing everyone because the counter is down would turn a
 * protection into an outage.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<RateRule | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (rule === undefined) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const who =
      rule.by === 'user'
        ? (request.user?.id ?? request.ip ?? 'unknown')
        : (request.ip ?? 'unknown');
    const key = `vfm:rl:${rule.name}:${who}`;
    try {
      const count = await this.redis.connection.incr(key);
      if (count === 1) {
        await this.redis.connection.expire(key, rule.windowSeconds);
      }
      if (count > rule.limit) {
        const ttl = await this.redis.connection.ttl(key);
        rateLimited.inc({ name: rule.name });
        throw new ThrottledException(
          'too many requests; try again later',
          ttl > 0 ? ttl : rule.windowSeconds,
        );
      }
    } catch (error: unknown) {
      if (error instanceof ThrottledException) {
        throw error;
      }
      this.logger.warn(
        `rate limit for ${rule.name} could not be checked: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    return true;
  }
}
