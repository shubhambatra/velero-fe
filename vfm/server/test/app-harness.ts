import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { ProblemExceptionFilter } from '../src/common/problem.filter';
import { requestIdMiddleware } from '../src/common/request-id';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Boots the real application for the end-to-end suites.
 *
 * Shared rather than copied into each test file, because the two drifted
 * immediately: `VFM_MASTER_KEY` became required and one suite set it while the
 * other did not, which showed up as an unrelated-looking
 * "invalid environment configuration" failure. The middleware stack here is
 * the one `main.ts` installs, so the behaviour under test is the behaviour
 * that ships.
 */
export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  /** A fresh cookie-keeping client. */
  api: () => request.Agent;
  /** Truncates the tables and flushes the Redis database. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://vfm:vfm-dev-password@localhost:55432/vfm_test?schema=public';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:56379/15';

export async function createTestApp(): Promise<TestApp> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.NODE_ENV = 'test';
  // Errors still print, because a 500 in a test is worth seeing; the
  // per-request log lines are not.
  process.env.LOG_LEVEL = 'error';
  // A fixed key: these tests assert on ciphertext round-tripping, not on
  // key secrecy, and a stable value keeps failures reproducible.
  process.env.VFM_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');

  Logger.overrideLogger(false);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.use(requestIdMiddleware);
  app.use(cookieParser());
  app.use(json({ limit: '1mb' }));
  app.useGlobalFilters(new ProblemExceptionFilter());
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });

  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  return {
    app,
    prisma,
    redis,
    api: () => request.agent(app.getHttpServer() as never),
    reset: async () => {
      // `users` cascades to memberships and recovery codes.
      await prisma.user.deleteMany();
      await redis.connection.flushdb();
    },
    close: async () => {
      await prisma.user.deleteMany();
      await redis.connection.flushdb();
      await app.close();
    },
  };
}

/** Reads a cookie value out of a `Set-Cookie` header list. */
export function readCookie(cookies: string[], name: string): string {
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (match === undefined) {
    throw new Error(`cookie ${name} was not set`);
  }
  return decodeURIComponent(match.slice(name.length + 1).split(';')[0] ?? '');
}
