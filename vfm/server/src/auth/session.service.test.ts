import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionService } from './session.service';
import { FakeRedis } from '../../test/fake-redis';
import type { RedisService } from '../redis/redis.service';

/**
 * Sessions are exercised against an in-memory Redis double rather than a live
 * server, because the behaviour under test is TTL arithmetic: the absolute and
 * idle windows of PLAN.md §8.3 only differ at the hour and half-day marks, and
 * waiting for them is not a test. The double implements the handful of
 * commands this service uses, including TTL semantics, so the assertions are
 * about our logic rather than about ioredis.
 *
 * `test/fake-redis.ts` is also what the day 5 MFA and day 9 API-token tests
 * will use.
 */
describe('SessionService', () => {
  let redis: FakeRedis;
  let sessions: SessionService;

  const input = {
    userId: '0192f2a0-0000-7000-8000-000000000001',
    ip: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T09:00:00.000Z'));
    redis = new FakeRedis();
    sessions = new SessionService({ connection: redis } as unknown as RedisService);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  describe('create', () => {
    it('issues an unguessable id and a separate csrf token', async () => {
      const a = await sessions.create(input);
      const b = await sessions.create(input);

      // 32 bytes, base64url.
      expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(a.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // The csrf token must not be derived from the session id, or holding
      // one would hand over the other.
      expect(a.csrfToken).not.toBe(a.id);
      expect(a.id).not.toBe(b.id);
    });

    it('sets the absolute deadline 12 hours out (PLAN.md §8.3)', async () => {
      const { record } = await sessions.create(input);

      expect(record.absoluteExpiresAt - record.createdAt).toBe(12 * 60 * 60 * 1_000);
    });

    it('sets the idle TTL to one hour', async () => {
      const { id } = await sessions.create(input);

      expect(await redis.ttl(`vfm:sess:${id}`)).toBe(60 * 60);
    });

    it('records the session in the per-user index', async () => {
      const { id } = await sessions.create(input);

      expect(await redis.smembers(`vfm:sess:user:${input.userId}`)).toStrictEqual([id]);
    });

    it('does not start a session already pending MFA as fully authenticated', async () => {
      const { record } = await sessions.create({ ...input, mfaPending: true });

      expect(record.mfaPending).toBe(true);
    });
  });

  describe('touch', () => {
    it('returns the record and slides the idle window forward', async () => {
      const { id } = await sessions.create(input);

      vi.advanceTimersByTime(50 * 60 * 1_000); // 50 minutes, inside the idle hour
      redis.advance(50 * 60);

      const record = await sessions.touch(id);

      expect(record?.userId).toBe(input.userId);
      // Refreshed back to a full hour rather than the 10 minutes that remained.
      expect(await redis.ttl(`vfm:sess:${id}`)).toBe(60 * 60);
    });

    it('returns null once the idle hour lapses', async () => {
      const { id } = await sessions.create(input);

      redis.advance(60 * 60 + 1);

      expect(await sessions.touch(id)).toBeNull();
    });

    it('returns null at the 12-hour absolute deadline even under constant use', async () => {
      const { id } = await sessions.create(input);

      // Touch every 50 minutes so the idle window never lapses. The absolute
      // cap is the only thing that can end this session.
      for (let elapsed = 0; elapsed < 12 * 60; elapsed += 50) {
        vi.advanceTimersByTime(50 * 60 * 1_000);
        redis.advance(50 * 60);
        await sessions.touch(id);
      }

      expect(await sessions.touch(id)).toBeNull();
      // And it is gone, not merely refused.
      expect(await redis.get(`vfm:sess:${id}`)).toBeNull();
    });

    it('never extends the idle window past the absolute deadline', async () => {
      const { id } = await sessions.create(input);

      // Kept alive in 50-minute steps up to 11 h 40 m, so only 20 minutes of
      // absolute lifetime remain. The idle window must be clamped to that,
      // otherwise the key would outlive the session it represents.
      for (let step = 0; step < 14; step += 1) {
        vi.advanceTimersByTime(50 * 60 * 1_000);
        redis.advance(50 * 60);
        await sessions.touch(id);
      }

      expect(await redis.ttl(`vfm:sess:${id}`)).toBe(20 * 60);
    });

    it('returns null for an unknown id', async () => {
      expect(await sessions.touch('nope')).toBeNull();
    });

    it('discards and deletes a record it cannot parse', async () => {
      const { id } = await sessions.create(input);
      await redis.set(`vfm:sess:${id}`, 'not json', 'EX', 3_600);

      expect(await sessions.touch(id)).toBeNull();
      expect(await redis.get(`vfm:sess:${id}`)).toBeNull();
    });

    it('rejects a record whose shape is wrong, not just unparseable', async () => {
      const { id } = await sessions.create(input);
      await redis.set(`vfm:sess:${id}`, JSON.stringify({ userId: 42 }), 'EX', 3_600);

      expect(await sessions.touch(id)).toBeNull();
    });
  });

  describe('rotate', () => {
    it('issues a new id and invalidates the old one (PLAN.md §8.3)', async () => {
      const original = await sessions.create(input);

      const rotated = await sessions.rotate(original.id, input);

      expect(rotated.id).not.toBe(original.id);
      expect(await sessions.touch(original.id)).toBeNull();
      expect(await sessions.touch(rotated.id)).not.toBeNull();
    });

    it('leaves no trace of the old id in the user index', async () => {
      const original = await sessions.create(input);
      const rotated = await sessions.rotate(original.id, input);

      expect(await redis.smembers(`vfm:sess:user:${input.userId}`)).toStrictEqual([rotated.id]);
    });
  });

  describe('destroy', () => {
    it('removes the session and its index entry', async () => {
      const { id } = await sessions.create(input);

      await sessions.destroy(id);

      expect(await sessions.touch(id)).toBeNull();
      expect(await redis.smembers(`vfm:sess:user:${input.userId}`)).toStrictEqual([]);
    });

    it('is a no-op for an unknown id', async () => {
      await expect(sessions.destroy('nope')).resolves.toBeUndefined();
    });
  });

  describe('destroyAllForUser — "sign out everywhere"', () => {
    it('revokes every session for the user', async () => {
      const a = await sessions.create(input);
      const b = await sessions.create(input);
      const c = await sessions.create(input);

      expect(await sessions.destroyAllForUser(input.userId)).toBe(3);

      for (const session of [a, b, c]) {
        expect(await sessions.touch(session.id)).toBeNull();
      }
    });

    it('can keep the caller signed in, which is what the button promises', async () => {
      const mine = await sessions.create(input);
      const other = await sessions.create(input);

      expect(await sessions.destroyAllForUser(input.userId, { except: mine.id })).toBe(1);

      expect(await sessions.touch(mine.id)).not.toBeNull();
      expect(await sessions.touch(other.id)).toBeNull();
    });

    it('does not touch sessions belonging to another user', async () => {
      const mine = await sessions.create(input);
      const theirs = await sessions.create({ ...input, userId: 'another-user' });

      await sessions.destroyAllForUser(input.userId);

      expect(await sessions.touch(mine.id)).toBeNull();
      expect(await sessions.touch(theirs.id)).not.toBeNull();
    });
  });

  describe('listForUser', () => {
    it('returns live sessions with their ids', async () => {
      const a = await sessions.create(input);
      await sessions.create(input);

      const listed = await sessions.listForUser(input.userId);

      expect(listed).toHaveLength(2);
      expect(listed.map((s) => s.id)).toContain(a.id);
      expect(listed[0]?.ip).toBe(input.ip);
    });

    it('prunes index entries whose sessions have expired', async () => {
      const a = await sessions.create(input);
      redis.advance(60 * 60 + 1);
      const b = await sessions.create(input);

      const listed = await sessions.listForUser(input.userId);

      expect(listed.map((s) => s.id)).toStrictEqual([b.id]);
      expect(await redis.smembers(`vfm:sess:user:${input.userId}`)).toStrictEqual([b.id]);
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('csrfMatches', () => {
    it('accepts the exact token', () => {
      expect(SessionService.csrfMatches('abc123', 'abc123')).toBe(true);
    });

    it('rejects a different token, a prefix, and an empty string', () => {
      expect(SessionService.csrfMatches('abc123', 'abc124')).toBe(false);
      expect(SessionService.csrfMatches('abc123', 'abc')).toBe(false);
      expect(SessionService.csrfMatches('abc123', '')).toBe(false);
    });
  });
});
