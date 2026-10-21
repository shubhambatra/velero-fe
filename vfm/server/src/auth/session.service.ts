import { randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { PRODUCT_SLUG } from '@vfm/shared';

import { RedisService } from '../redis/redis.service';

/**
 * Server-side sessions (PLAN.md §8.3, §9).
 *
 * §9 is explicit that sessions live in Redis and not in Postgres, which also
 * makes revocation immediate: the session record *is* the authority, so
 * disabling a user or signing out everywhere takes effect on the next request
 * rather than whenever a token happens to expire. There is no JWT here on
 * purpose — a stateless token cannot be revoked.
 *
 * Two independent lifetimes, both from §8.3:
 *   - **12 h absolute** — stored on the record and checked on every read, so
 *     it cannot be extended by activity.
 *   - **1 h idle** — the Redis TTL, refreshed on each request. An abandoned
 *     browser tab stops being a credential an hour later.
 *
 * A per-user index set supports "sign out everywhere" and lets a privilege
 * change invalidate every other session the user holds.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  /** §8.3: 12 h absolute. */
  static readonly ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1_000;
  /** §8.3: 1 h idle. */
  static readonly IDLE_TTL_SECONDS = 60 * 60;

  /** Name of the session cookie. */
  static readonly COOKIE = `${PRODUCT_SLUG}_session`;
  /** Name of the CSRF cookie (readable by the SPA, hence not httpOnly). */
  static readonly CSRF_COOKIE = `${PRODUCT_SLUG}_csrf`;

  constructor(private readonly redis: RedisService) {}

  /**
   * Creates a session and returns the id to put in the cookie.
   *
   * 32 bytes of CSPRNG output, base64url: the id is the bearer of all
   * authority here, so it must be unguessable and is never derived from
   * anything about the user.
   */
  async create(input: CreateSessionInput): Promise<CreatedSession> {
    const id = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = Date.now();

    const record: SessionRecord = {
      userId: input.userId,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + SessionService.ABSOLUTE_TTL_MS,
      csrfToken,
      ip: input.ip,
      userAgent: input.userAgent,
      // True while a second-factor obligation is unsatisfied. The session is
      // real — the challenge has to be answerable — but authenticates nothing
      // until this clears (PLAN.md §8.3; see SessionGuard).
      mfaPending: input.mfaPending ?? false,
      mfaPendingReason: input.mfaPendingReason ?? null,
      // "sudo mode" re-auth timestamp (§8.3). Login counts as a re-auth.
      lastReauthAt: now,
      // The org the UI is showing; chosen with POST /me/active-org.
      activeOrgId: null,
    };

    const pipeline = this.redis.connection.multi();
    pipeline.set(sessionKey(id), JSON.stringify(record), 'EX', SessionService.IDLE_TTL_SECONDS);
    pipeline.sadd(userKey(input.userId), id);
    // The index must not outlive the longest possible session, or it grows
    // without bound for users who never sign out explicitly.
    pipeline.expire(userKey(input.userId), absoluteTtlSeconds());
    await pipeline.exec();

    return { id, csrfToken, record };
  }

  /**
   * Loads a session and refreshes its idle window.
   *
   * Returns null for anything that is not a live, in-window session — expired,
   * revoked, absent or unparseable all look identical to a caller, which is
   * what we want at an authentication boundary.
   */
  async touch(id: string): Promise<SessionRecord | null> {
    const raw = await this.redis.connection.get(sessionKey(id));
    if (raw === null) {
      return null;
    }

    const record = parse(raw);
    if (record === null) {
      // A record we cannot read is a record we cannot trust.
      await this.destroy(id);
      return null;
    }

    const now = Date.now();
    if (now >= record.absoluteExpiresAt) {
      // The idle TTL would have kept this alive indefinitely under steady
      // use; the absolute cap is what stops that.
      await this.destroy(id);
      return null;
    }

    record.lastSeenAt = now;

    // Never extend the idle window past the absolute deadline, so the key
    // disappears on its own even if nothing reads it again.
    const remaining = Math.ceil((record.absoluteExpiresAt - now) / 1_000);
    const ttl = Math.min(SessionService.IDLE_TTL_SECONDS, remaining);

    await this.redis.connection.set(sessionKey(id), JSON.stringify(record), 'EX', Math.max(ttl, 1));

    return record;
  }

  /**
   * Whether a session is still live, **without** extending it. A long-lived SSE
   * connection checks this periodically: using `touch` would let an open browser
   * tab keep a session alive forever, defeating the idle timeout.
   */
  async isLive(id: string): Promise<boolean> {
    const raw = await this.redis.connection.get(sessionKey(id));
    if (raw === null) {
      return false;
    }
    const record = parse(raw);
    return record !== null && Date.now() < record.absoluteExpiresAt && !record.mfaPending;
  }

  /** Overwrites the mutable parts of a live session. */
  async update(
    id: string,
    changes: Partial<
      Pick<SessionRecord, 'mfaPending' | 'mfaPendingReason' | 'lastReauthAt' | 'activeOrgId'>
    >,
  ): Promise<void> {
    const raw = await this.redis.connection.get(sessionKey(id));
    if (raw === null) {
      return;
    }
    const record = parse(raw);
    if (record === null) {
      return;
    }

    const updated = { ...record, ...changes };
    const remaining = Math.ceil((updated.absoluteExpiresAt - Date.now()) / 1_000);
    if (remaining <= 0) {
      await this.destroy(id);
      return;
    }

    await this.redis.connection.set(
      sessionKey(id),
      JSON.stringify(updated),
      'EX',
      Math.min(SessionService.IDLE_TTL_SECONDS, remaining),
    );
  }

  /**
   * Issues a new session id for the same user and drops the old one.
   *
   * PLAN.md §8.3 requires rotation on privilege change. Reusing the id after a
   * privilege change would leave a session identifier that was observed under
   * weaker authority still valid under stronger authority.
   */
  async rotate(id: string, input: CreateSessionInput): Promise<CreatedSession> {
    const created = await this.create(input);
    await this.destroy(id);
    return created;
  }

  async destroy(id: string): Promise<void> {
    const raw = await this.redis.connection.get(sessionKey(id));
    const record = raw === null ? null : parse(raw);

    const pipeline = this.redis.connection.multi();
    pipeline.del(sessionKey(id));
    if (record !== null) {
      pipeline.srem(userKey(record.userId), id);
    }
    await pipeline.exec();
  }

  /**
   * "Sign out everywhere" (§8.3), also used when a user is disabled or their
   * privileges change.
   *
   * `except` keeps the caller's own session alive, which is what a user
   * expects from a "sign out my other devices" button.
   */
  async destroyAllForUser(userId: string, options: { except?: string } = {}): Promise<number> {
    const ids = await this.redis.connection.smembers(userKey(userId));
    const doomed = ids.filter((id) => id !== options.except);

    if (doomed.length > 0) {
      const pipeline = this.redis.connection.multi();
      for (const id of doomed) {
        pipeline.del(sessionKey(id));
        pipeline.srem(userKey(userId), id);
      }
      await pipeline.exec();
      this.logger.log(`revoked ${doomed.length.toString()} session(s) for user ${userId}`);
    }

    return doomed.length;
  }

  /** Live sessions for a user, for the sessions-list endpoint (M1 day 9). */
  async listForUser(userId: string): Promise<(SessionRecord & { id: string })[]> {
    const ids = await this.redis.connection.smembers(userKey(userId));
    if (ids.length === 0) {
      return [];
    }

    const raws = await this.redis.connection.mget(ids.map(sessionKey));
    const live: (SessionRecord & { id: string })[] = [];
    const stale: string[] = [];

    ids.forEach((id, index) => {
      const raw = raws[index];
      const record = raw === undefined || raw === null ? null : parse(raw);
      if (record === null) {
        stale.push(id);
      } else {
        live.push({ ...record, id });
      }
    });

    // Opportunistic cleanup: expired keys leave their ids behind in the index.
    if (stale.length > 0) {
      await this.redis.connection.srem(userKey(userId), ...stale);
    }

    return live;
  }

  /**
   * Constant-time comparison of a submitted CSRF token against the session's.
   *
   * Timing-safe because the token is a secret of the same kind as the session
   * id, and `===` on strings leaks its prefix.
   */
  static csrfMatches(expected: string, submitted: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(submitted, 'utf8');
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}

export interface CreateSessionInput {
  userId: string;
  ip: string;
  userAgent: string;
  mfaPending?: boolean;
  mfaPendingReason?: MfaPendingReason | null;
}

/**
 * Why a second factor is outstanding.
 *
 * `challenge` — the user has MFA and must enter a code.
 * `enrolment` — the user owes MFA by role or org policy and has none yet, so
 * they must set one up before doing anything else (PLAN.md §8.3 makes it
 * required for Owner/Admin by default).
 */
export type MfaPendingReason = 'challenge' | 'enrolment';

export interface SessionRecord {
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  csrfToken: string;
  ip: string;
  userAgent: string;
  mfaPending: boolean;
  mfaPendingReason: MfaPendingReason | null;
  lastReauthAt: number;
  /**
   * The organization the caller is working in (PLAN.md §8.1 "switches org in
   * the UI"). Optional so a session written before day 6 still parses. It is a
   * *preference*, never an authorization: every org route re-checks membership.
   */
  activeOrgId?: string | null;
}

export interface CreatedSession {
  id: string;
  csrfToken: string;
  record: SessionRecord;
}

function sessionKey(id: string): string {
  return `${PRODUCT_SLUG}:sess:${id}`;
}

function userKey(userId: string): string {
  return `${PRODUCT_SLUG}:sess:user:${userId}`;
}

function absoluteTtlSeconds(): number {
  return Math.ceil(SessionService.ABSOLUTE_TTL_MS / 1_000);
}

function parse(raw: string): SessionRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isSessionRecord(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userId === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.absoluteExpiresAt === 'number' &&
    typeof candidate.csrfToken === 'string'
  );
}
