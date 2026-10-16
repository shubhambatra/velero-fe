import type { IncomingMessage } from 'node:http';

import { Inject, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { PINO_REDACT_PATHS } from './common/redact';
import { REQUEST_ID_HEADER, requestIdOf } from './common/request-id';
import { ConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env.schema';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { SudoGuard } from './auth/sudo.guard';
import { ClustersModule } from './clusters/clusters.module';
import { CommandsModule } from './commands/commands.module';
import { EventsModule } from './events/events.module';
import { InventoryModule } from './inventory/inventory.module';
import { DownloadsModule } from './downloads/downloads.module';
import { CryptoModule } from './crypto/crypto.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { RbacModule } from './rbac/rbac.module';
import { OidcModule } from './oidc/oidc.module';
import { OrgsModule } from './orgs/orgs.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { TokensModule } from './tokens/tokens.module';
import { UsersModule } from './users/users.module';

/**
 * Whether `pino-pretty` can actually be loaded.
 *
 * It is a devDependency (LOG_PRETTY is a development convenience and
 * production emits JSON), so this keeps `LOG_PRETTY=true` in an image that
 * does not bundle it from taking the process down at startup.
 */
function prettyTransportAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

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
          //
          // pino-pretty is a devDependency, so a production image does not
          // carry it. Asking for it there must degrade to JSON rather than
          // refuse to boot — a logging preference is never worth an outage.
          ...(env.LOG_PRETTY && prettyTransportAvailable()
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
    CryptoModule,
    MailModule,
    UsersModule,
    OrgsModule,
    AuditModule,
    TokensModule,
    OidcModule,
    RbacModule,
    ClustersModule,
    GatewayModule,
    CommandsModule,
    InventoryModule,
    DownloadsModule,
    EventsModule,
    AuthModule,
    HealthModule,
  ],
  providers: [
    // Order matters: authentication resolves the session first, so the CSRF
    // guard can compare the submitted token against the session's copy.
    // Both are global, which makes authentication and CSRF deny-by-default —
    // a new controller is protected the moment it exists (PLAN.md §12.1).
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    // Last: the session must be resolved before its re-authentication age can
    // be judged (PLAN.md §8.3 sudo mode).
    { provide: APP_GUARD, useClass: SudoGuard },
  ],
})
export class AppModule {
  constructor(@Inject(ENV) readonly env: Env) {}
}
