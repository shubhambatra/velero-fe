import { RateLimitGuard } from './common/rate-limit';
import type { IncomingMessage } from 'node:http';

import { Inject, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';

import { PINO_REDACT_PATHS } from './common/redact';
import { REQUEST_ID_HEADER, requestIdOf } from './common/request-id';
import { ConfigModule, ENV } from './config/config.module';
import type { Env } from './config/env.schema';
import { AuditModule } from './audit/audit.module';
import { AlertsModule } from './alerts/alerts.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { ConfigBackupModule } from './config-backup/config-backup.module';
import { ReportsModule } from './reports/reports.module';
import { RetentionModule } from './retention/retention.module';
import { AuthModule } from './auth/auth.module';
import { CsrfGuard } from './auth/csrf.guard';
import { SessionGuard } from './auth/session.guard';
import { SudoGuard } from './auth/sudo.guard';
import { ClustersModule } from './clusters/clusters.module';
import { CommandsModule } from './commands/commands.module';
import { EventsModule } from './events/events.module';
import { InventoryModule } from './inventory/inventory.module';
import { BackupsModule } from './backups/backups.module';
import { DownloadsModule } from './downloads/downloads.module';
import { LogsModule } from './logs/logs.module';
import { RestoresModule } from './restores/restores.module';
import { SchedulesModule } from './schedules/schedules.module';
import { StorageModule } from './storage/storage.module';
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
import { MetricsModule } from './metrics/metrics.module';

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

/**
 * Where log lines go. Always the process's own stdout, except in tests that need to read
 * what was logged (the credentials grep test): they set `stream` before the app is built.
 */
export const logDestination: { stream?: DestinationStream } = {};

/** What a request log line may say about the request. Never the query string, never headers beyond these. */
export function serializeRequest(req: {
  id?: unknown;
  method?: string;
  url?: string;
  remoteAddress?: string;
  headers?: Record<string, unknown>;
}): Record<string, unknown> {
  const agent = req.headers?.['user-agent'];
  return {
    id: req.id,
    method: req.method,
    url: req.url?.split('?')[0],
    remoteAddress: req.remoteAddress,
    ...(typeof agent === 'string' ? { userAgent: agent.slice(0, 200) } : {}),
  };
}

export function serializeResponse(res: { statusCode?: number }): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

@Module({
  imports: [
    ConfigModule,
    MetricsModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          ...(logDestination.stream === undefined ? {} : { stream: logDestination.stream }),
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
          // A short allowlist, not the whole request: the query string carries one-time codes (the SSO
          // callback's `code` and `state`) and the full header set is noise at best. docs/OBSERVABILITY.md.
          serializers: { req: serializeRequest, res: serializeResponse },
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
    BackupsModule,
    RestoresModule,
    SchedulesModule,
    StorageModule,
    DownloadsModule,
    LogsModule,
    AlertsModule,
    ReportsModule,
    ConfigBackupModule,
    RetentionModule,
    ApprovalsModule,
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
    // After the session, so a signed-in caller is counted as themselves.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Last: the session must be resolved before its re-authentication age can
    // be judged (PLAN.md §8.3 sudo mode).
    { provide: APP_GUARD, useClass: SudoGuard },
  ],
})
export class AppModule {
  constructor(@Inject(ENV) readonly env: Env) {}
}
