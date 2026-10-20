/**
 * `node dist/retention.js`: one retention pass (docs/OPERATIONS.md). For installations that keep the
 * application's database login unable to delete audit events and run this on a schedule with a separate
 * login that is a member of `vfm_audit_retention` (set that login as DATABASE_URL for this command).
 * Exit 0 = complete, 1 = something was skipped or refused, 2 = could not run.
 */
import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AuditModule } from './audit/audit.module';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RetentionModule } from './retention/retention.module';
import { RetentionService } from './retention/retention.service';

@Module({ imports: [ConfigModule, PrismaModule, RedisModule, AuditModule, RetentionModule] })
class RetentionCliModule {}

async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(RetentionCliModule, {
    logger: ['log', 'error', 'warn'],
  });
  try {
    const report = await app.get(RetentionService).run();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.partial ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `retention could not run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  },
);
