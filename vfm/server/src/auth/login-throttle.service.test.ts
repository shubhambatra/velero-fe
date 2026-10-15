import { beforeEach, describe, expect, it } from 'vitest';

import { delayFor, LoginThrottleService } from './login-throttle.service';
import { FakeRedis } from '../../test/fake-redis';
import type { RedisService } from '../redis/redis.service';

describe('LoginThrottleService', () => {
  let redis: FakeRedis;
  let throttle: LoginThrottleService;

  const alice = { email: 'alice@example.com', ip: '203.0.113.9' };
  const bob = { email: 'bob@example.com', ip: '203.0.113.9' };
  const aliceElsewhere = { email: 'alice@example.com', ip: '198.51.100.4' };

  beforeEach(() => {
    redis = new FakeRedis();
    throttle = new LoginThrottleService({ connection: redis } as unknown as RedisService);
  });

  async function fail(identity: typeof alice, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await throttle.recordFailure(identity);
    }
  }

  describe('progressive delay', () => {
    it('leaves the first two attempts completely free', () => {
      expect(delayFor(0)).toBe(0);
      expect(delayFor(1)).toBe(0);
      expect(delayFor(2)).toBe(0);
    });

    it('backs off exponentially from the third attempt', () => {
      expect(delayFor(3)).toBe(500);
      expect(delayFor(4)).toBe(1_000);
      expect(delayFor(5)).toBe(2_000);
    });

    it('caps, so a worker is never held for long', () => {
      expect(delayFor(6)).toBe(4_000);
      expect(delayFor(50)).toBe(4_000);
      expect(delayFor(10_000)).toBe(LoginThrottleService.MAX_DELAY_MS);
    });

    it('is applied to the next attempt as failures accumulate', async () => {
      await fail(alice, 3);

      const decision = await throttle.check(alice);

      expect(decision.allowed).toBe(true);
      expect(decision.delayMs).toBe(500);
    });

    it('stays at zero for a user who simply mistyped once', async () => {
      await fail(alice, 1);

      expect((await throttle.check(alice)).delayMs).toBe(0);
    });
  });

  describe('account lockout', () => {
    it('allows attempts right up to the limit', async () => {
      await fail(alice, LoginThrottleService.ACCOUNT_MAX_FAILURES - 1);

      expect((await throttle.check(alice)).allowed).toBe(true);
    });

    it('locks the account on the tenth failure', async () => {
      await fail(alice, LoginThrottleService.ACCOUNT_MAX_FAILURES);

      const decision = await throttle.check(alice);

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('account_locked');
        expect(decision.retryAfterSeconds).toBe(LoginThrottleService.ACCOUNT_LOCKOUT_SECONDS);
      }
    });

    it('reports the lockout exactly once, so one notification is sent', async () => {
      // PLAN.md §8.3 asks for a lockout notification email. Reporting
      // `lockedNow` on every later attempt would mail the user repeatedly
      // while an attack is in progress.
      const outcomes = [];
      for (let i = 0; i < LoginThrottleService.ACCOUNT_MAX_FAILURES + 5; i += 1) {
        outcomes.push(await throttle.recordFailure(alice));
      }

      expect(outcomes.filter((o) => o.lockedNow)).toHaveLength(1);
      expect(outcomes[LoginThrottleService.ACCOUNT_MAX_FAILURES - 1]?.lockedNow).toBe(true);
    });

    it('does not extend an active lock, so an attacker cannot hold it open', async () => {
      await fail(alice, LoginThrottleService.ACCOUNT_MAX_FAILURES);
      const initial = await throttle.lockoutRemaining(alice.email);

      // Ten more minutes of hammering.
      redis.advance(10 * 60);
      await fail(alice, 20);

      const remaining = await throttle.lockoutRemaining(alice.email);
      expect(remaining).toBeLessThan(initial);
      expect(remaining).toBe(LoginThrottleService.ACCOUNT_LOCKOUT_SECONDS - 10 * 60);
    });

    it('expires on its own, because a permanent lock is a denial of service', async () => {
      await fail(alice, LoginThrottleService.ACCOUNT_MAX_FAILURES);
      expect((await throttle.check(alice)).allowed).toBe(false);

      redis.advance(LoginThrottleService.ACCOUNT_LOCKOUT_SECONDS + 1);

      expect((await throttle.check(alice)).allowed).toBe(true);
    });

    it('locks one account without affecting another', async () => {
      await fail(alice, LoginThrottleService.ACCOUNT_MAX_FAILURES);

      expect((await throttle.check(alice)).allowed).toBe(false);
      expect((await throttle.check(bob)).allowed).toBe(true);
    });

    it('follows the account across source addresses', async () => {
      // Otherwise rotating IPs — the cheap part of an attack — defeats the
      // account limit entirely.
      await fail(alice, LoginThrottleService.ACCOUNT_MAX_FAILURES);

      expect((await throttle.check(aliceElsewhere)).allowed).toBe(false);
    });

    it('counts attempts against an address that does not exist', async () => {
      // Otherwise the throttle itself becomes an account-enumeration oracle:
      // an attacker learns which emails are real by seeing which ones lock.
      await fail({ email: 'nobody@example.com', ip: alice.ip }, 10);

      expect((await throttle.check({ email: 'nobody@example.com', ip: alice.ip })).allowed).toBe(
        false,
      );
    });
  });

  describe('per-IP limit', () => {
    it('refuses an address that has failed against many accounts', async () => {
      // Credential stuffing: each attempt targets a different account, so no
      // single account counter ever trips.
      for (let i = 0; i < LoginThrottleService.IP_MAX_FAILURES; i += 1) {
        await throttle.recordFailure({ email: `user${i.toString()}@example.com`, ip: alice.ip });
      }

      const decision = await throttle.check({ email: 'fresh@example.com', ip: alice.ip });

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('ip_throttled');
      }
    });

    it('leaves other addresses alone', async () => {
      for (let i = 0; i < LoginThrottleService.IP_MAX_FAILURES; i += 1) {
        await throttle.recordFailure({ email: `user${i.toString()}@example.com`, ip: alice.ip });
      }

      expect((await throttle.check(aliceElsewhere)).allowed).toBe(true);
    });

    it('expires with its window', async () => {
      for (let i = 0; i < LoginThrottleService.IP_MAX_FAILURES; i += 1) {
        await throttle.recordFailure({ email: `user${i.toString()}@example.com`, ip: alice.ip });
      }

      redis.advance(LoginThrottleService.IP_WINDOW_SECONDS + 1);

      expect((await throttle.check({ email: 'fresh@example.com', ip: alice.ip })).allowed).toBe(
        true,
      );
    });
  });

  describe('the failure window is fixed, not sliding', () => {
    it('does not let a slow attacker stay under the limit forever', async () => {
      // A sliding window would push the deadline out on every failure, so an
      // attacker pacing themselves would never accumulate a count.
      await fail(alice, 5);
      const ttlAfterFive = await redis.ttl('vfm:login:fail:account:alice@example.com');

      redis.advance(5 * 60);
      await fail(alice, 1);
      const ttlAfterSix = await redis.ttl('vfm:login:fail:account:alice@example.com');

      expect(ttlAfterSix).toBe(ttlAfterFive - 5 * 60);
      expect(await throttle.failuresFor(alice.email)).toBe(6);
    });

    it('forgets failures once the window passes', async () => {
      await fail(alice, 5);

      redis.advance(LoginThrottleService.ACCOUNT_WINDOW_SECONDS + 1);

      expect(await throttle.failuresFor(alice.email)).toBe(0);
      expect((await throttle.check(alice)).delayMs).toBe(0);
    });
  });

  describe('recordSuccess', () => {
    it('clears the account counter and any lock', async () => {
      await fail(alice, LoginThrottleService.ACCOUNT_MAX_FAILURES);

      await throttle.recordSuccess(alice);

      expect(await throttle.failuresFor(alice.email)).toBe(0);
      expect(await throttle.lockoutRemaining(alice.email)).toBe(0);
      expect((await throttle.check(alice)).allowed).toBe(true);
    });

    it('leaves the IP counter standing', async () => {
      // One success does not clear suspicion of credential stuffing from an
      // address — a stuffing run contains successes by definition.
      for (let i = 0; i < 10; i += 1) {
        await throttle.recordFailure({ email: `user${i.toString()}@example.com`, ip: alice.ip });
      }

      await throttle.recordSuccess(alice);

      // The per-IP count is untouched; only the account keys were cleared.
      expect(await redis.get(`vfm:login:fail:ip:${alice.ip}`)).toBe('10');
    });
  });
});
