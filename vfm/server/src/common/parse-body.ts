import { UnprocessableEntityException } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a request body against a zod schema (PLAN.md §4.2 uses zod,
 * §12.1 requires validation at every boundary).
 *
 * Failures become 422 with one entry per offending field, which the global
 * problem+json filter renders as RFC 9457 `errors` (§10). Every field is
 * reported, not just the first, so a client gets one complete answer.
 *
 * Why this rather than Nest's `ValidationPipe`: the plan standardises on zod
 * schemas that are *shared with the web app* via `packages/shared`, so the
 * schema is the contract. class-validator DTOs would mean maintaining the
 * same rules twice, in two languages of validation.
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);

  if (!result.success) {
    throw new UnprocessableEntityException({
      message: result.error.issues.map(
        (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
      ),
    });
  }

  return result.data;
}
