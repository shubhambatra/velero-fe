import { Global, Module } from '@nestjs/common';

import { type Env, validateEnv } from './env.schema';

/** Injection token for the validated environment. */
export const ENV = Symbol('VFM_ENV');

/**
 * Validates the environment exactly once, at startup, and exposes the result
 * as a typed object (PLAN.md §4.2).
 *
 * Nothing in the codebase reads `process.env` directly. That keeps the
 * configuration surface reviewable — the zod schema in `env.schema.ts` is the
 * complete list of what an operator may set.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => validateEnv(process.env),
    },
  ],
  exports: [ENV],
})
export class ConfigModule {}
