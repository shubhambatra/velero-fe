import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * End-to-end suite: boots the real Nest application against the dev stack's
 * PostgreSQL and Redis.
 *
 * Separate from the unit config because these tests need services running
 * (`make dev-up`) and are far slower, so `pnpm test` stays fast and
 * dependency-free while CI runs both.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e.test.ts'],
    globals: false,
    // One file at a time: they share a database and truncate between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
