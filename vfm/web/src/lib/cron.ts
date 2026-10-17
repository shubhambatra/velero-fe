import { nextRuns, parseCron, type Cron, type EveryCron, type ParsedCron } from '@vfm/shared';

export { nextRuns, parseCron };
export type { Cron, EveryCron, ParsedCron };

// ---------------------------------------------------------------------------
// The builder: common patterns to and from an expression.

export type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface Pattern {
  frequency: Frequency;
  /** UTC. */
  minute: number;
  hour: number;
  /** 0 = Sunday. */
  weekday: number;
  dayOfMonth: number;
}

export const DEFAULT_PATTERN: Pattern = {
  frequency: 'daily',
  minute: 0,
  hour: 2,
  weekday: 1,
  dayOfMonth: 1,
};

export function expressionFor(p: Pattern): string {
  switch (p.frequency) {
    case 'hourly':
      return `${p.minute.toString()} * * * *`;
    case 'daily':
      return `${p.minute.toString()} ${p.hour.toString()} * * *`;
    case 'weekly':
      return `${p.minute.toString()} ${p.hour.toString()} * * ${p.weekday.toString()}`;
    case 'monthly':
      return `${p.minute.toString()} ${p.hour.toString()} ${p.dayOfMonth.toString()} * *`;
    case 'custom':
      return '';
  }
}

/** The pattern an expression is an instance of, or `custom`. */
export function patternOf(expression: string): Pattern {
  const m = /^(\d{1,2}) (\d{1,2}|\*) (\d{1,2}|\*) \* (\d|\*)$/.exec(expression.trim());
  const custom = { ...DEFAULT_PATTERN, frequency: 'custom' as const };
  if (m === null) return custom;
  const [, mi, h, dom, dow] = m;
  const minute = Number(mi);
  if (minute > 59) return custom;
  if (h === '*' && dom === '*' && dow === '*')
    return { ...DEFAULT_PATTERN, frequency: 'hourly', minute };
  const hour = Number(h);
  if (h === '*' || hour > 23) return custom;
  if (dom === '*' && dow === '*') return { ...DEFAULT_PATTERN, frequency: 'daily', minute, hour };
  if (dom === '*' && dow !== '*' && Number(dow) <= 6) {
    return { ...DEFAULT_PATTERN, frequency: 'weekly', minute, hour, weekday: Number(dow) };
  }
  if (dom !== '*' && dow === '*' && Number(dom) >= 1 && Number(dom) <= 31) {
    return { ...DEFAULT_PATTERN, frequency: 'monthly', minute, hour, dayOfMonth: Number(dom) };
  }
  return custom;
}
