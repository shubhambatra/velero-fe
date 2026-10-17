import { z } from 'zod';

export const ALERT_RULE_TYPES = [
  'BACKUP_FAILED',
  'SCHEDULE_MISSED',
  'AGENT_DISCONNECTED',
  'BSL_UNAVAILABLE',
  'BACKUP_EXPIRING',
] as const;
export type AlertRuleType = (typeof ALERT_RULE_TYPES)[number];

/** Minutes between repeats of a notification for a condition that stays true; 0 never repeats. */
const renotifyMinutes = z.number().int().min(0).max(10_080).default(240);

/**
 * What each rule type takes (PLAN.md §16 day 32). Strict: an unknown key is a typo, and a
 * typo in an alert rule is a rule that silently watches the wrong thing.
 */
export const PARAMS: Record<AlertRuleType, z.ZodType<Record<string, unknown>>> = {
  BACKUP_FAILED: z
    .object({
      /** Only failures this recent count; older ones are left alone. */
      lookbackHours: z.number().int().min(1).max(720).default(24),
      /** Also alert on PartiallyFailed, not just Failed. */
      includePartiallyFailed: z.boolean().default(true),
      renotifyMinutes,
    })
    .strict(),
  SCHEDULE_MISSED: z
    .object({
      /** Late when no backup came within this many of the schedule's longest intervals. */
      factor: z.number().min(1).max(10).default(1.5),
      renotifyMinutes,
    })
    .strict(),
  AGENT_DISCONNECTED: z
    .object({
      minutes: z.number().int().min(1).max(10_080).default(10),
      renotifyMinutes,
    })
    .strict(),
  BSL_UNAVAILABLE: z.object({ renotifyMinutes }).strict(),
  BACKUP_EXPIRING: z
    .object({
      withinDays: z.number().int().min(1).max(365).default(3),
      renotifyMinutes,
    })
    .strict(),
};

/** The scope of a rule: which clusters. Empty or missing means every cluster of the org. */
export const scopeSchema = z
  .object({ clusterIds: z.array(z.uuid()).max(500).default([]) })
  .strict();

export type RuleScope = z.infer<typeof scopeSchema>;

export function parseParams(
  type: AlertRuleType,
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const result = PARAMS[type].safeParse(raw ?? {});
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        message: result.error.issues
          .map((i) => `${i.path.join('.') || 'params'}: ${i.message}`)
          .join('; '),
      };
}
