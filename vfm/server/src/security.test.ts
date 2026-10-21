import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { applySecurity, bodyErrors } from './security';
import type { Env } from './config/env.schema';

@Controller()
class Probe {
  @Get('ping')
  ping() {
    return { ok: true };
  }
}

describe('applySecurity', () => {
  let app: INestApplication | undefined;

  async function boot(nodeEnv: 'production' | 'development'): Promise<request.Agent> {
    const module = await Test.createTestingModule({ controllers: [Probe] }).compile();
    app = module.createNestApplication();
    applySecurity(app, { NODE_ENV: nodeEnv } as Env);
    await app.init();
    return request(app.getHttpServer() as Parameters<typeof request>[0]);
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('adds HSTS and upgrade-insecure-requests in production, where the API is only reached over TLS (M-3)', async () => {
    const res = await (await boot('production')).get('/ping').expect(200);
    expect(res.headers['strict-transport-security']).toMatch(
      /^max-age=31536000; includeSubDomains/,
    );
    expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });

  it('does not add HSTS outside production, which would poison localhost', async () => {
    const res = await (await boot('development')).get('/ping').expect(200);
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('keeps the same strict policy in both modes', async () => {
    for (const mode of ['production', 'development'] as const) {
      const res = await (await boot(mode)).get('/ping').expect(200);
      expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
      expect(res.headers['content-security-policy']).not.toMatch(/unsafe-/);
      await app?.close();
    }
  });
});

describe('bodyErrors', () => {
  const run = (error: unknown) => {
    let seen: unknown;
    bodyErrors(error, {} as never, {} as never, (e?: unknown) => {
      seen = e;
    });
    return seen as { getStatus?: () => number; message?: string } | undefined;
  };

  it('turns the parser’s refusals into a fixed sentence and keeps their status', () => {
    const e = run({ status: 413, type: 'entity.too.large', message: 'request entity too large' });
    expect(e?.getStatus?.()).toBe(413);
    expect(e?.message).toBe('The request body is too large.');
    const parse = run({
      status: 400,
      type: 'entity.parse.failed',
      message: 'Unexpected token \'T\', "TOPSECRET" is not valid JSON',
    });
    expect(parse?.getStatus?.()).toBe(400);
    expect(parse?.message).not.toContain('TOPSECRET');
  });

  it('passes anything else on untouched', () => {
    const boom = new Error('boom');
    expect(run(boom)).toBe(boom);
    const server = { status: 500, type: 'x' };
    expect(run(server)).toBe(server);
  });
});
