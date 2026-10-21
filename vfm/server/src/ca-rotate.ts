/**
 * `node dist/ca-rotate.js status|stage|unstage|promote|retire [--force]`: replaces the internal CA
 * without re-enrolling agents (docs/DECISIONS.md ADR-043, docs/THREAT_MODEL.md G-12).
 *
 * Like `rewrap`, it starts only configuration, database and key ring, so it runs next to a live control
 * plane, whose replicas pick the change up within 30 seconds. Exit 0 = done, 1 = refused (too
 * early, or not in the right state), 2 = could not run. Every step is logged; keep the output.
 */
import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { CaRotationError, CaRotationService } from './ca/ca-rotation.service';
import { CaService, caOptions } from './ca/ca.service';
import { ConfigModule } from './config/config.module';
import { CryptoModule } from './crypto/crypto.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule, CryptoModule],
  providers: [CaService, CaRotationService],
})
class CaRotateModule {}

const STEPS = ['status', 'stage', 'unstage', 'promote', 'retire'] as const;

async function main(): Promise<number> {
  const step = process.argv[2];
  if (!STEPS.includes(step as (typeof STEPS)[number])) {
    process.stderr.write(`usage: ca-rotate <${STEPS.join('|')}> [--force]\n`);
    return 2;
  }
  caOptions.refreshMs = 0;
  const app = await NestFactory.createApplicationContext(CaRotateModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const rotation = app.get(CaRotationService);
    const force = process.argv.includes('--force');
    if (step === 'stage') await rotation.stage();
    if (step === 'unstage') await rotation.unstage();
    if (step === 'promote') await rotation.promote({ force });
    if (step === 'retire') await rotation.retire({ force });
    process.stdout.write(`${JSON.stringify(await rotation.status(), null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CaRotationError) {
      process.stderr.write(`refused: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `ca-rotate could not run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  },
);
