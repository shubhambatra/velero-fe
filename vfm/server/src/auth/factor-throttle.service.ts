import { Injectable, Logger } from '@nestjs/common';

import { ThrottledException } from '../common/throttled.exception';
import { RedisService } from '../redis/redis.service';

/**
 * Attempt limits for everything that asks a signed-in (or half signed-in) person to prove
 * themselves again: the second factor at login, the sudo window by password or by code, and
 * disabling MFA (PLAN.md §8.3).
 *
 * The login throttle protects the password. These paths are reached with a stolen session
 * cookie or a phished password, and a six-digit code has only a million values: unlimited
 * tries would find it in hours. So failures are counted **per user, not per session** (a new
 * session cannot reset the count), and after {@link MAX_FAILURES} the user is refused every
 * such attempt for {@link LOCK_SECONDS}. The lock is timed, not permanent, so it cannot be
 * used to lock the real owner out for good, and it does not touch the password login.
 *
 * Counted together on purpose: an attacker who can try codes at `/auth/mfa/challenge` and at
 * `/auth/sudo` has one budget, not two.
 */
@Injectable()
export class FactorThrottleService {
  private readonly logger = new Logger(FactorThrottleService.name);

  static readonly MAX_FAILURES = 5;
  static readonly WINDOW_SECONDS = 10 * 60;
  static readonly LOCK_SECONDS = 10 * 60;

  constructor(private readonly redis: RedisService) {}

  /** Throws 429 while the user is locked out. Call before checking anything. */
  async assertOpen(userId: string): Promise<void> {
    const ttl = await this.redis.connection.ttl(lockKey(userId));
    if (ttl > 0) {
      throw new ThrottledException(
        'too many failed attempts to confirm your identity; try again later',
        ttl,
      );
    }
  }

  /** Counts a failure; the one that reaches the limit starts the lock. */
  async recordFailure(userId: string): Promise<void> {
    const key = failuresKey(userId);
    const count = await this.redis.connection.incr(key);
    if (count === 1) {
      await this.redis.connection.expire(key, FactorThrottleService.WINDOW_SECONDS);
    }
    if (count >= FactorThrottleService.MAX_FAILURES) {
      // NX: attempts during a lock do not extend it.
      const applied = await this.redis.connection.set(
        lockKey(userId),
        '1',
        'EX',
        FactorThrottleService.LOCK_SECONDS,
        'NX',
      );
      if (applied === 'OK') {
        this.logger.warn(`re-authentication locked for user ${userId} after repeated failures`);
      }
    }
  }

  /** A correct answer clears the count. */
  async recordSuccess(userId: string): Promise<void> {
    await this.redis.connection.del(failuresKey(userId));
  }
}

const failuresKey = (userId: string): string => `vfm:factor:fail:${userId}`;
const lockKey = (userId: string): string => `vfm:factor:lock:${userId}`;
