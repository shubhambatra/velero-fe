import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema';

const minimal = {
  DATABASE_URL: 'postgresql://vfm:dev@localhost:55432/vfm',
  REDIS_URL: 'redis://localhost:56379',
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
  });

  it('coerces numeric ports from their string environment form', () => {
    const env = validateEnv({ ...minimal, PORT: '8080', METRICS_PORT: '9191' });

    expect(env.PORT).toBe(8080);
    expect(env.METRICS_PORT).toBe(9191);
  });

  it('rejects a missing database or redis url', () => {
    expect(() => validateEnv({ REDIS_URL: minimal.REDIS_URL })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ DATABASE_URL: minimal.DATABASE_URL })).toThrow(/REDIS_URL/);
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
    it('is optional in M0, before any encrypted column exists', () => {
      expect(() => validateEnv({ ...minimal })).not.toThrow();
    });

    it('accepts exactly 32 bytes of base64', () => {
      const key = Buffer.alloc(32, 7).toString('base64');
      expect(validateEnv({ ...minimal, VFM_MASTER_KEY: key }).VFM_MASTER_KEY).toBe(key);
    });

    it('rejects a key that is not 32 bytes', () => {
      const short = Buffer.alloc(16, 7).toString('base64');
      const long = Buffer.alloc(64, 7).toString('base64');

      expect(() => validateEnv({ ...minimal, VFM_MASTER_KEY: short })).toThrow(/VFM_MASTER_KEY/);
      expect(() => validateEnv({ ...minimal, VFM_MASTER_KEY: long })).toThrow(/VFM_MASTER_KEY/);
    });
  });
});
