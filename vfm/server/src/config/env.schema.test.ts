import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

/** 32 bytes of key material, as base64. */
const KEY = Buffer.alloc(32, 7).toString('base64');

const minimal = {
  DATABASE_URL: 'postgresql://vfm:dev@localhost:55432/vfm',
  REDIS_URL: 'redis://localhost:56379',
  // Required from M1 day 5, where mfa_secret_encrypted becomes the first
  // encrypted column (PLAN.md §9).
  VFM_MASTER_KEY: KEY,
} satisfies NodeJS.ProcessEnv;

describe('validateEnv', () => {
  it('applies the documented defaults', () => {
    const env = validateEnv({ ...minimal });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    // PLAN.md §10 puts metrics on their own port so an Ingress mistake cannot
    // publish them.
    expect(env.METRICS_PORT).toBe(9090);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.LOG_PRETTY).toBe(false);
    // Tracing is opt-in.
    expect(env.OTEL_ENABLED).toBe(false);
    expect(validateEnv({ ...minimal, OTEL_ENABLED: 'true' }).OTEL_ENABLED).toBe(true);
  });

  it('coerces numeric ports from their string environment form', () => {
    const env = validateEnv({ ...minimal, PORT: '8080', METRICS_PORT: '9191' });

    expect(env.PORT).toBe(8080);
    expect(env.METRICS_PORT).toBe(9191);
  });

  it('rejects a missing database url, redis url or master key', () => {
    const { DATABASE_URL: _d, ...noDatabase } = minimal;
    const { REDIS_URL: _r, ...noRedis } = minimal;
    const { VFM_MASTER_KEY: _k, ...noKey } = minimal;

    expect(() => validateEnv(noDatabase)).toThrow(/DATABASE_URL/);
    expect(() => validateEnv(noRedis)).toThrow(/REDIS_URL/);
    expect(() => validateEnv(noKey)).toThrow(/VFM_MASTER_KEY/);
  });

  it('rejects connection strings with the wrong scheme', () => {
    expect(() => validateEnv({ ...minimal, DATABASE_URL: 'mysql://localhost/vfm' })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => validateEnv({ ...minimal, REDIS_URL: 'http://localhost:6379' })).toThrow(
      /REDIS_URL/,
    );
  });

  it('rejects out-of-range ports and unknown log levels', () => {
    expect(() => validateEnv({ ...minimal, PORT: '0' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...minimal, PORT: '70000' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...minimal, PORT: 'not-a-port' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...minimal, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('reports every offending variable at once, so one restart surfaces them all', () => {
    let message = '';
    try {
      validateEnv({ PORT: 'nope', LOG_LEVEL: 'loud' });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('VFM_MASTER_KEY');
    expect(message).toContain('PORT');
    expect(message).toContain('LOG_LEVEL');
  });

  it('never echoes a value back in the error, because the value is often the secret', () => {
    let message = '';
    try {
      validateEnv({
        ...minimal,
        DATABASE_URL: 'mysql://vfm:SUPER-SECRET-PASSWORD@db/vfm',
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('SUPER-SECRET-PASSWORD');
  });

  describe('VFM_MASTER_KEY', () => {
    it('is required, because the database holds encrypted columns', () => {
      // Booting without it would mean either writing a TOTP secret in the
      // clear or failing at the first write (PLAN.md §9).
      const { VFM_MASTER_KEY: _omitted, ...withoutKey } = minimal;

      expect(() => validateEnv(withoutKey)).toThrow(/VFM_MASTER_KEY/);
    });

    it('accepts exactly 32 bytes of base64', () => {
      expect(validateEnv({ ...minimal }).VFM_MASTER_KEY).toBe(KEY);
    });

    it('rejects a key that is not 32 bytes', () => {
      const short = Buffer.alloc(16, 7).toString('base64');
      const long = Buffer.alloc(64, 7).toString('base64');

      expect(() => validateEnv({ ...minimal, VFM_MASTER_KEY: short })).toThrow(/VFM_MASTER_KEY/);
      expect(() => validateEnv({ ...minimal, VFM_MASTER_KEY: long })).toThrow(/VFM_MASTER_KEY/);
      expect(() => validateEnv({ ...minimal, VFM_MASTER_KEY: '' })).toThrow(/VFM_MASTER_KEY/);
    });

    it('never echoes the key material in the error', () => {
      const short = Buffer.alloc(16, 9).toString('base64');
      let message = '';
      try {
        validateEnv({ ...minimal, VFM_MASTER_KEY: short });
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : '';
      }

      expect(message).toContain('VFM_MASTER_KEY');
      expect(message).not.toContain(short);
    });
  });

  describe('VFM_MASTER_KEY_PREVIOUS', () => {
    it('defaults to no retired keys', () => {
      expect(validateEnv({ ...minimal }).VFM_MASTER_KEY_PREVIOUS).toStrictEqual([]);
    });

    it('parses a comma-separated list, which is what a rotation sets', () => {
      const a = Buffer.alloc(32, 1).toString('base64');
      const b = Buffer.alloc(32, 2).toString('base64');

      expect(
        validateEnv({ ...minimal, VFM_MASTER_KEY_PREVIOUS: `${a}, ${b}` }).VFM_MASTER_KEY_PREVIOUS,
      ).toStrictEqual([a, b]);
    });

    it('ignores empty entries and stray whitespace', () => {
      const a = Buffer.alloc(32, 1).toString('base64');

      expect(
        validateEnv({ ...minimal, VFM_MASTER_KEY_PREVIOUS: `  ${a} , , ` }).VFM_MASTER_KEY_PREVIOUS,
      ).toStrictEqual([a]);
    });

    it('rejects a retired key of the wrong length', () => {
      // Silently dropping it would make every row encrypted under that key
      // unreadable, with no indication why.
      expect(() =>
        validateEnv({
          ...minimal,
          VFM_MASTER_KEY_PREVIOUS: Buffer.alloc(8, 1).toString('base64'),
        }),
      ).toThrow(/VFM_MASTER_KEY_PREVIOUS/);
    });
  });

  describe('Redis in production (threat model G-13)', () => {
    const production = { ...minimal, NODE_ENV: 'production' } satisfies NodeJS.ProcessEnv;

    it('refuses to start without a password, naming the variable and never its value', () => {
      const attempt = (): unknown =>
        validateEnv({ ...production, REDIS_URL: 'redis://redis.internal:6379/0' });

      expect(attempt).toThrow(/REDIS_URL.*password/);
      expect(attempt).not.toThrow(/redis\.internal/);
    });

    it('refuses a username with no password too', () => {
      expect(() => validateEnv({ ...production, REDIS_URL: 'redis://default@redis:6379' })).toThrow(
        /REDIS_URL/,
      );
    });

    it('starts with a password, with or without TLS', () => {
      expect(
        validateEnv({ ...production, REDIS_URL: 'redis://:s3cret@redis:6379' }).REDIS_URL,
      ).toBeDefined();
      expect(
        validateEnv({ ...production, REDIS_URL: 'rediss://default:s3cret@redis:6379' }).REDIS_URL,
      ).toBeDefined();
    });

    it('does not apply outside production, where the dev stack has none', () => {
      expect(validateEnv({ ...minimal, NODE_ENV: 'development' }).REDIS_URL).toBeDefined();
      expect(validateEnv({ ...minimal, NODE_ENV: 'test' }).REDIS_URL).toBeDefined();
    });
  });

  describe('agent limits (threat model G-10, G-11)', () => {
    it('has defaults a real agent is far below, and rejects nonsense', () => {
      const env = validateEnv({ ...minimal });
      expect(env.AGENT_MESSAGES_PER_SECOND).toBe(100);
      expect(env.AGENT_MESSAGE_BURST).toBe(1000);
      expect(env.GATEWAY_ENROLL_PER_MINUTE).toBe(30);
      expect(env.GATEWAY_ENROLL_MAX_INFLIGHT).toBe(16);
      expect(() => validateEnv({ ...minimal, AGENT_MESSAGES_PER_SECOND: '0' })).toThrow(
        /AGENT_MESSAGES_PER_SECOND/,
      );
      expect(() => validateEnv({ ...minimal, GATEWAY_ENROLL_MAX_INFLIGHT: '0' })).toThrow(
        /GATEWAY_ENROLL_MAX_INFLIGHT/,
      );
    });
  });
});
