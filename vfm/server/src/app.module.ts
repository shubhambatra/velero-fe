import type { IncomingMessage } from 'node:http';

import { Inject, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { PINO_REDACT_PATHS } from './common/redact';
import { REQUEST_ID_HEADER, requestIdOf } from './common/request-id';
import { ConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env.schema';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          // Structured JSON in every real deployment (PLAN.md §4.2); pretty
          // output is a local-development affordance only.
          ...(env.LOG_PRETTY
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
          redact: { paths: [...PINO_REDACT_PATHS], censor: '[REDACTED]' },
          // Correlate log lines with the id the client sees (PLAN.md §10).
          genReqId: (req: IncomingMessage) =>
            requestIdOf(req as unknown as { requestId?: string }) ?? '',
          customProps: () => ({ requestIdHeader: REQUEST_ID_HEADER }),
          // Probes are scraped every few seconds; logging them buries
          // everything useful.
          autoLogging: {
            ignore: (req: IncomingMessage) =>
              req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
          },
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
  ],
})
export class AppModule {
  constructor(@Inject(ENV) readonly env: Env) {}
}
