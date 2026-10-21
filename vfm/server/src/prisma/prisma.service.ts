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
import { orgScopeExtension, runInOrg, runUnscoped } from './org-scope';

/**
 * Postgres access for the control plane.
 *
 * PLAN.md §8.1 requires that every query be filtered by `org_id`, enforced by a
 * Prisma extension rather than left to reviewer discipline. The extension in
 * `org-scope.ts` attaches here, which is why all database access goes through
 * this one client: the instance Nest hands out *is* the extended client, so
 * there is no unscoped handle to the org-owned tables to reach for.
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
        // Per replica; see DATABASE_POOL_MAX for how it was sized.
        max: env.DATABASE_POOL_MAX,
        connectionTimeoutMillis: 10_000,
      }),
    });

    // Returning the extended client from the constructor makes it the object
    // Nest registers, so every consumer gets the scoped client and none can
    // hold the raw one. The extended client keeps this class on its prototype
    // chain, so the lifecycle hooks and helpers below still resolve.
    return this.$extends(orgScopeExtension) as unknown as this;
  }

  /**
   * Runs `fn` with every org-owned query pinned to `orgId` (PLAN.md §8.1).
   * See `org-scope.ts` for the exact guarantees.
   */
  inOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    return runInOrg(orgId, fn);
  }

  /**
   * Suspends org scoping for a cross-org operation. `reason` is required and
   * every call site is pinned by a test, so adding one is a reviewed decision.
   */
  unscoped<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    return runUnscoped(reason, fn);
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
