import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { type Express, json, urlencoded } from 'express';
import { Logger } from 'nestjs-pino';

import { PRODUCT_NAME } from '@vfm/shared';

import { AppModule } from './app.module';
import { ProblemExceptionFilter } from './common/problem.filter';
import { ENV } from './config/config.module';
import type { Env } from './config/env.schema';
import { startMetricsServer } from './metrics/metrics.server';
import { applySecurity, MAX_JSON_BODY } from './security';

/**
 * Loads `server/.env` when it is present, for local development.
 *
 * Deliberately *before* the Nest app is created, because the config module
 * validates `process.env` during construction. Node's built-in loader keeps
 * this dotenv-free, and `override: false` semantics are what we want: a real
 * environment variable always wins, so the file cannot quietly shadow what an
 * operator set. In Kubernetes there is no such file and every value comes from
 * the environment or a Secret (PLAN.md §12.1).
 */
function loadDotEnvForDevelopment(): void {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  const file = resolve(__dirname, '..', '.env');
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

async function bootstrap(): Promise<void> {
  loadDotEnvForDevelopment();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const env = app.get<Env>(ENV);

  app.useLogger(app.get(Logger));

  // The session and CSRF cookies are read on every request (PLAN.md §8.3).
  app.use(cookieParser());

  // Rate limiting keys on the client address, so X-Forwarded-For is only
  // trusted when an operator has said a proxy sits in front. Trusting it
  // unconditionally would let any caller spoof their way out of an IP limit.
  if (env.TRUST_PROXY !== 'false') {
    // Nest types getInstance() loosely, so the Express app is narrowed here
    // rather than threading `any` into the call.
    const express = app.getHttpAdapter().getInstance() as Express;
    express.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));
  }

  applySecurity(app, env);
  app.use(json({ limit: MAX_JSON_BODY }));
  app.use(urlencoded({ extended: false, limit: MAX_JSON_BODY }));

  app.useGlobalFilters(new ProblemExceptionFilter());

  // No global ValidationPipe. Request bodies are validated by zod through
  // `parseBody` (PLAN.md §4.2 standardises on zod, and §12.1 requires
  // validation at every boundary), so the pipe would have no DTOs to act on
  // while still requiring class-validator and class-transformer — which it
  // calls process.exit(1) over when they are absent.

  // PLAN.md §10: every REST route lives under /api/v1. The probes are
  // excluded because orchestrators and load balancers expect them at the root
  // and must keep working across API versions.
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });

  app.enableShutdownHooks();

  const metrics = startMetricsServer(env.HOST, env.METRICS_PORT);

  await app.listen(env.PORT, env.HOST);

  const logger = new NestLogger('Bootstrap');
  logger.log(`${PRODUCT_NAME} control plane listening on ${env.HOST}:${env.PORT.toString()}`);

  const closeMetrics = (): void => {
    metrics.close();
  };
  process.once('SIGTERM', closeMetrics);
  process.once('SIGINT', closeMetrics);
}

/**
 * Express accepts a hop count, `true`, or a subnet expression for
 * `trust proxy`. A numeric string must be passed as a number or it is read as
 * a (meaningless) hostname, which would silently disable forwarding support.
 */
function parseTrustProxy(value: string): number | boolean | string {
  if (value === 'true') {
    return true;
  }
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : value;
}

void bootstrap();
