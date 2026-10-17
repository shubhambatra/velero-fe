/**
 * `node dist/rewrap.js [--dry-run]`: moves every stored secret onto the primary `VFM_MASTER_KEY`
 * so a retired key can be removed from `VFM_MASTER_KEY_PREVIOUS` (docs/THREAT_MODEL.md G-9).
 *
 * It starts only the configuration, the database and the key ring, never the gateway or the HTTP
 * server, so it can run next to a live control plane. Exit 0 = nothing left on an old key,
 * 1 = some value could not be decrypted (nothing was changed for it), 2 = could not run.
 */
import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { ConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { RewrapService } from './crypto/rewrap.service';
import { PrismaModule } from './prisma/prisma.module';

@Module({ imports: [ConfigModule, PrismaModule, CryptoModule], providers: [RewrapService] })
class RewrapModule {}

async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(RewrapModule, {
    logger: ['log', 'error', 'warn'],
  });
  try {
    const report = await app.get(RewrapService).run({ dryRun: process.argv.includes('--dry-run') });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.failures.length === 0 ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `re-wrap could not run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  },
);
