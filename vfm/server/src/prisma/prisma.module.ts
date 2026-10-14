import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * Global because every feature module reads the database, and PLAN.md §8.1
 * requires a single client instance so the org-scoping extension (M1 day 6)
 * cannot be bypassed by a module constructing its own.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
