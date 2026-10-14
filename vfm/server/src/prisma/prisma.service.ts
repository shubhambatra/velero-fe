import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Postgres access for the control plane.
 *
 * PLAN.md §8.1 requires that every query be filtered by `org_id`, enforced by a
 * Prisma extension rather than left to reviewer discipline. That extension
 * lands in M1 day 6 together with the first org-owned tables; it attaches
 * here, which is why all database access goes through this one client.
 *
 * Prisma 7 takes its connection through a driver adapter rather than a
 * `datasource.url` in the schema (docs/DECISIONS.md ADR-007). Using the `pg`
 * adapter also means the pool is ours to size, which matters because the
 * control plane runs N replicas against one database (PLAN.md §3.2).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ENV) env: Env) {
    super({
      adapter: new PrismaPg({
        connectionString: env.DATABASE_URL,
        // Sized for several replicas sharing one Postgres. Revisited against
        // the §13 scale targets during the M7 load test.
        max: 10,
        connectionTimeoutMillis: 5_000,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('connected to postgres');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Cheap liveness probe for `/readyz` (PLAN.md §10). Deliberately a trivial
   * query: readiness should report whether the connection works, not how
   * loaded the database is.
   */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
