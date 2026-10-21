import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 removed `datasource.url` from `schema.prisma`: migration and
 * introspection commands read the connection string from here, and the runtime
 * client gets it through a driver adapter instead (see
 * `src/prisma/prisma.service.ts`). Recorded in docs/DECISIONS.md ADR-007.
 *
 * The URL always comes from the environment — PLAN.md §12.1 forbids committing
 * a connection string, and this file is committed.
 */

// Prisma 7 no longer loads .env on its own. Node's built-in loader keeps the
// developer workflow (`prisma migrate dev` with server/.env) working without a
// dotenv dependency. In CI and in Kubernetes the variable is already set.
const envFile = resolve(import.meta.dirname, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',

  // Only the migration and introspection commands need a reachable database.
  // `prisma generate` must work without one, so that a clean checkout can be
  // built in CI and in an air-gapped image build (PLAN.md §1.1 P6).
  ...(databaseUrl === undefined ? {} : { datasource: { url: databaseUrl } }),

  migrations: {
    path: 'prisma/migrations',
  },
});
