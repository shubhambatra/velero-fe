/**
 * Minimal runtime narrowing for data crossing the network boundary.
 *
 * PLAN.md §12.1 requires validation at every boundary and treats the agent as
 * semi-trusted, so nothing the control plane forwards is assumed to have the
 * declared shape. These guards are the stop-gap: once `@vfm/shared` exports
 * the zod schemas (PLAN.md §4.2), parsing moves there and this file shrinks to
 * whatever zod cannot express.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
