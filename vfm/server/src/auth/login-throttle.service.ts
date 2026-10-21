import { Injectable, Logger } from '@nestjs/common';

import { PRODUCT_SLUG } from '@vfm/shared';

import { RedisService } from '../redis/redis.service';

/**
 * Brute-force protection for the login path (PLAN.md §8.3: "per-IP and
 * per-account rate limits, progressive delay, lockout notification email").
 *
 * Two independent counters, because they defend against different attacks:
 *
 *   - **per account** stops someone working through a password list against
 *     one known user, and ends in a timed lockout.
 *   - **per IP** stops credential stuffing, where each attempt targets a
 *     *different* account and so never trips an account counter.
 *
 * The account counter is keyed on the submitted email rather than a user id,
 * so attempts against addresses that do not exist are counted too. Otherwise
 * an attacker could enumerate accounts by watching which inputs throttle.
 *
 * Both counters live in Redis (§3: "rate limits" is one of its listed jobs),
 * so the limits hold across control-plane replicas rather than per process.
 *
 * ## Why a delay *and* a lockout
 *
 * The progressive delay costs an attacker wall-clock time from the third
 * attempt onward while staying invisible to a user who simply mistyped.
 * Lockout is the hard stop, and it is deliberately **timed, not permanent**:
 * a permanent lock turns a rate limiter into a denial-of-service tool against
 * the legitimate owner of the account.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);

  /** Failures against one account before it is locked. */
  static readonly ACCOUNT_MAX_FAILURES = 10;
  /** How long an account stays locked. */
  static readonly ACCOUNT_LOCKOUT_SECONDS = 15 * 60;
  /** Window over which account failures accumulate. */
  static readonly ACCOUNT_WINDOW_SECONDS = 15 * 60;

  /** Failures from one IP before it is refused outright. */
  static readonly IP_MAX_FAILURES = 50;
  static readonly IP_WINDOW_SECONDS = 15 * 60;

  /** Attempts that are free of any added delay. */
  static readonly FREE_ATTEMPTS = 2;
  /** Cap on the progressive delay, so a worker is never held for long. */
  static readonly MAX_DELAY_MS = 4_000;

  constructor(private readonly redis: RedisService) {}

  /**
   * Checks whether this attempt may proceed, and how long to stall first.
   *
   * Called before the password is verified, so a locked account costs nothing
   * to reject.
   */
  async check(identity: LoginIdentity): Promise<ThrottleDecision> {
    const [lockTtl, accountFailures, ipFailures] = await Promise.all([
      this.redis.connection.ttl(lockKey(identity.email)),
      this.count(accountKey(identity.email)),
      this.count(ipKey(identity.ip)),
    ]);

    if (lockTtl > 0) {
      return { allowed: false, reason: 'account_locked', retryAfterSeconds: lockTtl, delayMs: 0 };
    }

    if (ipFailures >= LoginThrottleService.IP_MAX_FAILURES) {
      return {
        allowed: false,
        reason: 'ip_throttled',
        retryAfterSeconds: LoginThrottleService.IP_WINDOW_SECONDS,
        delayMs: 0,
      };
    }

    return { allowed: true, delayMs: delayFor(accountFailures) };
  }

  /**
   * Records a failed attempt and locks the account once it crosses the limit.
   *
   * Returns whether this failure caused the lockout, so the caller can send
   * the notification email §8.3 asks for exactly once rather than on every
   * subsequent attempt.
   */
  async recordFailure(identity: LoginIdentity): Promise<FailureOutcome> {
    const [accountFailures] = await Promise.all([
      this.increment(accountKey(identity.email), LoginThrottleService.ACCOUNT_WINDOW_SECONDS),
      this.increment(ipKey(identity.ip), LoginThrottleService.IP_WINDOW_SECONDS),
    ]);

    if (accountFailures < LoginThrottleService.ACCOUNT_MAX_FAILURES) {
      return { locked: false, lockedNow: false, failures: accountFailures };
    }

    // NX so a lock already in place is not silently extended by attempts that
    // arrive while it is active — otherwise an attacker could hold an account
    // locked indefinitely.
    const applied = await this.redis.connection.set(
      lockKey(identity.email),
      '1',
      'EX',
      LoginThrottleService.ACCOUNT_LOCKOUT_SECONDS,
      'NX',
    );

    const lockedNow = applied === 'OK';
    if (lockedNow) {
      this.logger.warn(
        `locked login for ${redactEmail(identity.email)} after ${accountFailures.toString()} failures`,
      );
    }

    return { locked: true, lockedNow, failures: accountFailures };
  }

  /** Clears the account counters after a successful login. */
  async recordSuccess(identity: LoginIdentity): Promise<void> {
    // The IP counter is deliberately left alone: one success does not clear
    // suspicion of credential stuffing from that address, which by definition
    // includes successes.
    await this.redis.connection.del(accountKey(identity.email), lockKey(identity.email));
  }

  /** Current failure count for an account, for tests and diagnostics. */
  async failuresFor(email: string): Promise<number> {
    return this.count(accountKey(email));
  }

  /** Remaining lockout in seconds, or 0 if not locked. */
  async lockoutRemaining(email: string): Promise<number> {
    const ttl = await this.redis.connection.ttl(lockKey(email));
    return ttl > 0 ? ttl : 0;
  }

  private async count(key: string): Promise<number> {
    const raw = await this.redis.connection.get(key);
    if (raw === null) {
      return 0;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private async increment(key: string, windowSeconds: number): Promise<number> {
    // INCR then EXPIRE only on first use, so the window is fixed from the
    // first failure rather than sliding forward with each one — a sliding
    // window would let a slow attacker stay under the limit forever.
    const pipeline = this.redis.connection.multi();
    pipeline.incr(key);
    pipeline.expire(key, windowSeconds, 'NX');
    const results = await pipeline.exec();

    const value = results?.[0]?.[1];
    return typeof value === 'number' ? value : 0;
  }
}

export interface LoginIdentity {
  /** Normalised (lower-cased, trimmed) email as submitted. */
  email: string;
  ip: string;
}

export type ThrottleDecision =
  | { allowed: true; delayMs: number }
  | {
      allowed: false;
      reason: 'account_locked' | 'ip_throttled';
      retryAfterSeconds: number;
      delayMs: number;
    };

export interface FailureOutcome {
  locked: boolean;
  /** True only on the attempt that applied the lock. */
  lockedNow: boolean;
  failures: number;
}

/**
 * Exponential backoff after a couple of free attempts, capped.
 *
 * 3rd failure 500 ms, 4th 1 s, 5th 2 s, 6th and beyond 4 s. Enough to make a
 * password list expensive, short enough that a user who fat-fingered their
 * password twice notices nothing.
 */
export function delayFor(failures: number): number {
  if (failures <= LoginThrottleService.FREE_ATTEMPTS) {
    return 0;
  }
  const step = failures - LoginThrottleService.FREE_ATTEMPTS;
  return Math.min(250 * 2 ** step, LoginThrottleService.MAX_DELAY_MS);
}

function accountKey(email: string): string {
  return `${PRODUCT_SLUG}:login:fail:account:${email}`;
}

function ipKey(ip: string): string {
  return `${PRODUCT_SLUG}:login:fail:ip:${ip}`;
}

function lockKey(email: string): string {
  return `${PRODUCT_SLUG}:login:lock:${email}`;
}

/** Enough of the address to correlate log lines, not enough to harvest. */
function redactEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const head = local.slice(0, 2);
  return `${head}***@${domain}`;
}
