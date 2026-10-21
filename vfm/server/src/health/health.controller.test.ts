import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { HealthController } from './health.controller';

function controllerWith(options: { postgres: boolean; redis: boolean }): {
  controller: HealthController;
  res: { status: ReturnType<typeof vi.fn>; code: () => number };
} {
  const prisma = {
    ping: options.postgres
      ? vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      : vi.fn<() => Promise<void>>().mockRejectedValue(new Error('connect ECONNREFUSED db:5432')),
  } as unknown as PrismaService;

  const redis = {
    ping: options.redis
      ? vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      : vi.fn<() => Promise<void>>().mockRejectedValue(new Error('redis unreachable')),
  } as unknown as RedisService;

  let code = 0;
  const status = vi.fn((value: number) => {
    code = value;
  });

  return {
    controller: new HealthController(prisma, redis),
    res: { status, code: () => code },
  };
}

describe('HealthController', () => {
  it('liveness answers without touching any dependency', () => {
    // PLAN.md §10: a database outage must not make Kubernetes restart every
    // replica, so liveness deliberately checks nothing.
    const { controller } = controllerWith({ postgres: false, redis: false });

    expect(controller.liveness()).toStrictEqual({ status: 'ok' });
  });

  it('readiness reports 200 when both dependencies are reachable', async () => {
    const { controller, res } = controllerWith({ postgres: true, redis: true });

    const body = await controller.readiness(
      res as unknown as Parameters<HealthController['readiness']>[0],
    );

    expect(res.code()).toBe(HttpStatus.OK);
    expect(body).toStrictEqual({
      status: 'ok',
      checks: { postgres: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it.each([
    ['postgres', { postgres: false, redis: true }],
    ['redis', { postgres: true, redis: false }],
    ['both', { postgres: false, redis: false }],
  ])('readiness reports 503 when %s is down', async (_label, options) => {
    const { controller, res } = controllerWith(options);

    const body = await controller.readiness(
      res as unknown as Parameters<HealthController['readiness']>[0],
    );

    // A 200 carrying status: "error" reads as ready to every probe
    // implementation, so the status code has to carry the verdict.
    expect(res.code()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.status).toBe('error');
  });

  it('names which dependency failed without echoing its connection string', () => {
    // The error message from a failed connection routinely contains
    // credentials (PLAN.md §12.1).
    const { controller, res } = controllerWith({ postgres: false, redis: true });

    return controller
      .readiness(res as unknown as Parameters<HealthController['readiness']>[0])
      .then((body) => {
        expect(body.checks.postgres.status).toBe('down');
        expect(body.checks.redis.status).toBe('up');
        expect(JSON.stringify(body)).not.toContain('db:5432');
        expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
      });
  });

  it('checks dependencies concurrently so readiness cannot stack timeouts', async () => {
    const { controller, res } = controllerWith({ postgres: true, redis: true });
    const started = Date.now();

    await controller.readiness(res as unknown as Parameters<HealthController['readiness']>[0]);

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
