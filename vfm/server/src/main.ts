import 'reflect-metadata';

import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { Logger } from 'nestjs-pino';

import { PRODUCT_NAME } from '@vfm/shared';

import { AppModule } from './app.module';
import { ProblemExceptionFilter } from './common/problem.filter';
import { ENV } from './config/config.module';
import type { Env } from './config/env.schema';
import { startMetricsServer } from './metrics/metrics.server';
import { applySecurity, MAX_JSON_BODY } from './security';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const env = app.get<Env>(ENV);

  app.useLogger(app.get(Logger));

  applySecurity(app, env);
  app.use(json({ limit: MAX_JSON_BODY }));
  app.use(urlencoded({ extended: false, limit: MAX_JSON_BODY }));

  app.useGlobalFilters(new ProblemExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

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

void bootstrap();
