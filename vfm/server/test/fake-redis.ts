/* eslint-disable @typescript-eslint/require-await --
 * Every method here is async with no await on purpose: it stands in for
 * ioredis, whose API is promise-based. Making the synchronous ones sync would
 * mean the double had a different shape from the thing it replaces, and the
 * code under test awaits all of them.
 */

/**
 * An in-memory stand-in for the subset of Redis this codebase uses.
 *
 * Why not Testcontainers here: the behaviour under test is TTL arithmetic.
 * PLAN.md §8.3's session windows (1 h idle, 12 h absolute) and §8.3's
 * rate-limit windows only differ at the hour and quarter-hour marks, and a
 * test that waits for them is not a test. {@link advance} moves this clock
 * instead, so the assertions are about our logic rather than about ioredis.
 *
 * Integration tests against a real Redis arrive with the Testcontainers suite
 * in M1 (PLAN.md §15), which is where ioredis itself gets exercised.
 *
 * Expiry is modelled as an absolute deadline on a virtual clock, matching
 * Redis: a key is gone once its deadline passes, whether or not anything
 * reads it.
 */
export class FakeRedis {
  private strings = new Map<string, { value: string; expiresAt: number | null }>();
  private sets = new Map<string, { members: Set<string>; expiresAt: number | null }>();
  private now = 0;

  /** Moves the virtual clock forward by `seconds`. */
  advance(seconds: number): void {
    this.now += seconds;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.strings.get(key);
    if (entry === undefined) {
      return null;
    }
    if (this.hasExpired(entry.expiresAt)) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    return Promise.all(keys.map((key) => this.get(key)));
  }

  /**
   * Supports the argument forms this codebase uses: `set(k, v)`,
   * `set(k, v, 'EX', seconds)` and `set(k, v, 'EX', seconds, 'NX')`.
   */
  async set(
    key: string,
    value: string,
    mode?: 'EX',
    seconds?: number,
    flag?: 'NX',
  ): Promise<'OK' | null> {
    if (flag === 'NX' && (await this.get(key)) !== null) {
      return null;
    }
    this.strings.set(key, {
      value,
      expiresAt: mode === 'EX' && seconds !== undefined ? this.now + seconds : null,
    });
    return 'OK';
  }

  /** Redis 6.2+ GETDEL: read and delete atomically. */
  async getdel(key: string): Promise<string | null> {
    const value = await this.get(key);
    this.strings.delete(key);
    return value;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) {
        removed += 1;
      }
      if (this.sets.delete(key)) {
        removed += 1;
      }
    }
    return removed;
  }

  async incr(key: string): Promise<number> {
    const current = await this.get(key);
    const next = (current === null ? 0 : Number.parseInt(current, 10)) + 1;
    // INCR preserves an existing TTL, which is what makes the fixed window in
    // LoginThrottleService work.
    const existing = this.strings.get(key);
    this.strings.set(key, { value: String(next), expiresAt: existing?.expiresAt ?? null });
    return next;
  }

  async expire(key: string, seconds: number, flag?: 'NX'): Promise<number> {
    const entry = this.strings.get(key) ?? this.sets.get(key);
    if (entry === undefined) {
      return 0;
    }
    if (flag === 'NX' && entry.expiresAt !== null) {
      return 0;
    }
    entry.expiresAt = this.now + seconds;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.strings.get(key) ?? this.sets.get(key);
    if (entry === undefined) {
      return -2; // Redis: key does not exist.
    }
    if (entry.expiresAt === null) {
      return -1; // Redis: no expiry set.
    }
    if (this.hasExpired(entry.expiresAt)) {
      await this.del(key);
      return -2;
    }
    return entry.expiresAt - this.now;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const entry = this.sets.get(key) ?? { members: new Set<string>(), expiresAt: null };
    if (this.hasExpired(entry.expiresAt)) {
      entry.members.clear();
      entry.expiresAt = null;
    }
    let added = 0;
    for (const member of members) {
      if (!entry.members.has(member)) {
        entry.members.add(member);
        added += 1;
      }
    }
    this.sets.set(key, entry);
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const entry = this.sets.get(key);
    if (entry === undefined) {
      return 0;
    }
    let removed = 0;
    for (const member of members) {
      if (entry.members.delete(member)) {
        removed += 1;
      }
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.sets.get(key);
    if (entry === undefined || this.hasExpired(entry.expiresAt)) {
      this.sets.delete(key);
      return [];
    }
    return [...entry.members];
  }

  async ping(): Promise<'PONG'> {
    return 'PONG';
  }

  /**
   * A pipeline that applies commands in order on `exec`.
   *
   * Real `MULTI` is atomic; this is sequential. Nothing in this codebase
   * depends on isolation from a concurrent writer within a transaction — the
   * one place that needs atomicity uses `GETDEL`, a single command.
   */
  multi(): FakePipeline {
    return new FakePipeline(this);
  }

  private hasExpired(expiresAt: number | null): boolean {
    return expiresAt !== null && expiresAt <= this.now;
  }
}

type QueuedCommand = () => Promise<unknown>;

export class FakePipeline {
  private queue: QueuedCommand[] = [];

  constructor(private readonly redis: FakeRedis) {}

  set(key: string, value: string, mode?: 'EX', seconds?: number, flag?: 'NX'): this {
    this.queue.push(() => this.redis.set(key, value, mode, seconds, flag));
    return this;
  }

  del(...keys: string[]): this {
    this.queue.push(() => this.redis.del(...keys));
    return this;
  }

  incr(key: string): this {
    this.queue.push(() => this.redis.incr(key));
    return this;
  }

  expire(key: string, seconds: number, flag?: 'NX'): this {
    this.queue.push(() => this.redis.expire(key, seconds, flag));
    return this;
  }

  sadd(key: string, ...members: string[]): this {
    this.queue.push(() => this.redis.sadd(key, ...members));
    return this;
  }

  srem(key: string, ...members: string[]): this {
    this.queue.push(() => this.redis.srem(key, ...members));
    return this;
  }

  /** Matches ioredis's `[error, result]` tuples. */
  async exec(): Promise<[Error | null, unknown][]> {
    const results: [Error | null, unknown][] = [];
    for (const command of this.queue) {
      try {
        results.push([null, await command()]);
      } catch (error: unknown) {
        results.push([error instanceof Error ? error : new Error(String(error)), null]);
      }
    }
    this.queue = [];
    return results;
  }
}
