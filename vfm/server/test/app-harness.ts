import { fleetOptions } from '../src/inventory/fleet.service';
import { caOptions } from '../src/ca/ca.service';
import { rbacOptions } from '../src/rbac/rbac.service';
import { resourceOptions } from '../src/inventory/resources.service';
import { applySecurity, bodyErrors, MAX_JSON_BODY } from '../src/security';
import { ENV } from '../src/config/config.module';
import type { Env } from '../src/config/env.schema';
import { type INestApplication, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import request from 'supertest';

import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule, logDestination } from '../src/app.module';
import { ProblemExceptionFilter } from '../src/common/problem.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService, type MailMessage } from '../src/mail/mail.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * Stands in for SMTP in the end-to-end suites, so a test can read what would
 * have been sent. The real transport is exercised by hand against Mailpit
 * (docs/PROGRESS.md records it); nothing here reaches a network.
 */
export class FakeMail {
  outbox: MailMessage[] = [];
  configured = true;
  failNext = false;

  send(message: MailMessage): Promise<void> {
    if (!this.configured) {
      return Promise.reject(new ServiceUnavailableException('email delivery is not configured'));
    }
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('relay refused'));
    }
    this.outbox.push(message);
    return Promise.resolve();
  }

  /** The invitation token from the last message sent to `to`. */
  tokenFor(to: string): string {
    const message = [...this.outbox].reverse().find((m) => m.to === to);
    const match = message === undefined ? null : /token=([^\s&]+)/.exec(message.text);
    if (match?.[1] === undefined) {
      throw new Error(`no invitation mail for ${to}`);
    }
    return decodeURIComponent(match[1]);
  }
}

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
  mail: FakeMail;
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

export async function createTestApp(
  options: {
    gateway?: boolean;
    /** Connect through these instead of the shared test databases (the resilience suite puts a fault proxy in between). */
    databaseUrl?: string;
    redisUrl?: string;
    /** Capture every log line the application writes, at debug level, into this sink. */
    logTo?: (line: string) => void;
  } = {},
): Promise<TestApp> {
  process.env.DATABASE_URL = options.databaseUrl ?? TEST_DATABASE_URL;
  process.env.REDIS_URL = options.redisUrl ?? TEST_REDIS_URL;
  process.env.NODE_ENV = 'test';
  // Errors still print, because a 500 in a test is worth seeing; the
  // per-request log lines are not.
  process.env.LOG_LEVEL = options.logTo === undefined ? 'error' : 'debug';
  if (options.logTo === undefined) {
    delete logDestination.stream;
  } else {
    const sink = options.logTo;
    logDestination.stream = {
      write: (line: string) => {
        sink(line);
      },
    };
  }
  // A fixed key: these tests assert on ciphertext round-tripping, not on
  // key secrecy, and a stable value keeps failures reproducible.
  process.env.VFM_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');

  // Suites that never talk to an agent must not bind a port: they run in
  // parallel workers and 8443 would collide. The gateway suite opts in and gets
  // an ephemeral port.
  process.env.GATEWAY_ENABLED = options.gateway === true ? 'true' : 'false';
  process.env.GATEWAY_PORT = '0';
  // A quiet connect: suites that assert on exactly which commands an agent
  // receives turn the on-connect Velero refresh on for the one case that tests it.
  process.env.COMMANDS_REFRESH_ON_CONNECT = 'false';
  // Alerts are evaluated by hand in tests.
  process.env.ALERT_EVAL_INTERVAL_SECONDS = '0';
  // Webhook receivers in tests are local http servers; the egress rules are tested by flipping these.
  process.env.ALERT_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.ALERT_WEBHOOK_ALLOW_HTTP = 'true';
  // The fake identity provider is a local http server.
  process.env.OIDC_ALLOW_PRIVATE = 'true';
  process.env.OIDC_ALLOW_HTTP = 'true';
  process.env.HOST = '127.0.0.1';

  Logger.overrideLogger(false);

  const mail = new FakeMail();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();

  const app = moduleRef.createNestApplication();
  if (options.logTo !== undefined) {
    // As main.ts does: service logs go through pino too, so the sink sees them.
    app.useLogger(app.get(PinoLogger));
  }
  // As main.ts does, so every end-to-end test runs under the real headers and body limit.
  app.use(cookieParser());
  applySecurity(app, app.get<Env>(ENV));
  // Tests read what they have just written; the production sharing of aggregates would show them stale counts.
  fleetOptions.cacheMs = 0;
  caOptions.refreshMs = 0;
  rbacOptions.cacheMs = 0;
  resourceOptions.coverageCacheMs = 0;
  app.use(json({ limit: MAX_JSON_BODY }));
  app.use(bodyErrors);
  app.useGlobalFilters(new ProblemExceptionFilter());
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });

  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  return {
    app,
    prisma,
    redis,
    mail,
    api: () => request.agent(app.getHttpServer() as never),
    reset: async () => {
      // Orgs cascade to memberships, teams and invites; users to recovery codes.
      await prisma.organization.deleteMany();
      await prisma.user.deleteMany();
      mail.outbox = [];
      await redis.connection.flushdb();
    },
    close: async () => {
      await prisma.organization.deleteMany();
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

/**
 * Inserts clusters with fixed ids, so a suite that exercises role bindings and
 * token limits has real rows for the foreign key to point at (docs/DECISIONS.md
 * ADR-012: the constraint arrived with the `clusters` table in M2).
 */
export async function seedClusters(
  prisma: PrismaService,
  orgId: string,
  ids: readonly string[],
): Promise<void> {
  await prisma.inOrg(orgId, () =>
    prisma.cluster.createMany({
      data: ids.map((id) => ({ id, orgId, name: `cluster-${id.slice(-4)}` })),
      // A cluster id belongs to one org. A second org in the same test is
      // meant to find it absent, so a repeat is skipped rather than an error.
      skipDuplicates: true,
    }),
  );
}
