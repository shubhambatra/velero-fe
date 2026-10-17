import { z } from 'zod';

/** A Kubernetes name: what `namespace`, `pod` and `container` must be before they go anywhere. */
const kubeName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, 'not a valid Kubernetes name');

export const MAX_TAIL_LINES = 10_000;
export const MAX_SINCE_SECONDS = 7 * 24 * 3600;
export const DEFAULT_TAIL_LINES = 200;

/**
 * `POST …/log-sessions` (PLAN.md §7.2). `previous` reads the last terminated container
 * and cannot be followed, so it ends once read.
 */
export const startLogSessionBody = z
  .object({
    namespace: kubeName.max(63),
    pod: kubeName,
    container: kubeName.max(63).optional(),
    tailLines: z.number().int().min(0).max(MAX_TAIL_LINES).default(DEFAULT_TAIL_LINES),
    sinceSeconds: z.number().int().min(1).max(MAX_SINCE_SECONDS).optional(),
    previous: z.boolean().default(false),
    timestamps: z.boolean().default(false),
  })
  .strict();

export type StartLogSessionBody = z.infer<typeof startLogSessionBody>;
