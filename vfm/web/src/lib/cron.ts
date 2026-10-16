/**
 * Cron expressions as Velero reads them (robfig/cron's standard parser): five fields,
 * the `@yearly`-style descriptors and `@every <duration>`. Used for the schedule form's
 * "next runs" preview, so what is shown is what Velero will do (PLAN.md §11.1).
 *
 * Velero evaluates an expression in the time zone of its own process, normally UTC.
 * Everything here works in UTC; callers show the instants in whatever zone they like.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DESCRIPTORS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export interface ParsedCron {
  kind: 'fields';
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** The field started with `*` or was `?`: it then does not restrict the day. */
  domAny: boolean;
  dowAny: boolean;
}

export interface EveryCron {
  kind: 'every';
  seconds: number;
}

export type Cron = ParsedCron | EveryCron;

interface Rule {
  name: string;
  lo: number;
  hi: number;
  names?: readonly string[];
  nameBase?: number;
  allowAny: boolean;
}

const RULES: Rule[] = [
  { name: 'minute', lo: 0, hi: 59, allowAny: false },
  { name: 'hour', lo: 0, hi: 23, allowAny: false },
  { name: 'day of month', lo: 1, hi: 31, allowAny: true },
  { name: 'month', lo: 1, hi: 12, names: MONTHS, nameBase: 1, allowAny: false },
  { name: 'day of week', lo: 0, hi: 6, names: WEEKDAYS, nameBase: 0, allowAny: true },
];

const UNIT_SECONDS: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  µs: 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};

function everySeconds(text: string): number {
  if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(text)) return Number.NaN;
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    total += Number(m[1]) * (UNIT_SECONDS[m[2] ?? 's'] ?? 0);
  }
  return total;
}

function value(text: string, rule: Rule): number | string {
  const named = rule.names?.indexOf(text.toLowerCase()) ?? -1;
  if (named >= 0) return named + (rule.nameBase ?? 0);
  if (!/^\d+$/.test(text)) return `"${text}" is not a number or a name`;
  const n = Number(text);
  return n < rule.lo || n > rule.hi
    ? `${n.toString()} is outside ${rule.lo.toString()}–${rule.hi.toString()}`
    : n;
}

function parseField(field: string, rule: Rule): { values: Set<number>; any: boolean } | string {
  const values = new Set<number>();
  for (const item of field.split(',')) {
    if (item === '') return `empty list item in "${field}"`;
    const [range = '', step, ...extra] = item.split('/');
    if (extra.length > 0) return `"${item}" has more than one step`;
    if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1)) {
      return `step "${step}" must be a positive number`;
    }
    const stepBy = step === undefined ? 1 : Number(step);
    let lo: number;
    let hi: number;
    if (range === '*' || (rule.allowAny && range === '?')) {
      lo = rule.lo;
      hi = rule.hi;
    } else {
      const [a = '', b, ...more] = range.split('-');
      if (more.length > 0) return `"${range}" is not a range`;
      const x = value(a, rule);
      if (typeof x === 'string') return x;
      lo = x;
      hi = x;
      if (b !== undefined) {
        const y = value(b, rule);
        if (typeof y === 'string') return y;
        if (y < x) return `range "${range}" runs backwards`;
        hi = y;
      } else if (step !== undefined) {
        // "5/10" means from 5 to the end of the range.
        hi = rule.hi;
      }
    }
    for (let v = lo; v <= hi; v += stepBy) values.add(v);
  }
  const any = field.startsWith('*') || field === '?';
  return { values, any };
}

/** The parsed expression, or a message saying what is wrong with it. */
export function parseCron(expression: string): { cron: Cron } | { error: string } {
  const text = expression.trim();
  if (text === '') return { error: 'A cron expression is required.' };
  if (text.startsWith('@')) {
    const expanded = DESCRIPTORS[text];
    if (expanded !== undefined) return parseCron(expanded);
    const every = /^@every\s+(.+)$/.exec(text);
    if (every !== null) {
      const seconds = everySeconds((every[1] ?? '').trim());
      return seconds >= 1
        ? { cron: { kind: 'every', seconds } }
        : { error: '@every needs a duration of at least one second, such as "@every 6h".' };
    }
    return { error: `Unknown descriptor "${text}".` };
  }
  const parts = text.split(/\s+/);
  if (parts.length !== 5) {
    return {
      error: `A cron expression has five fields (minute hour day-of-month month day-of-week); this has ${parts.length.toString()}.`,
    };
  }
  const parsed = parts.map((part, i) => {
    const rule = RULES[i];
    return rule === undefined ? 'unexpected field' : parseField(part, rule);
  });
  for (const [i, p] of parsed.entries()) {
    if (typeof p === 'string') return { error: `Invalid ${RULES[i]?.name ?? 'field'}: ${p}.` };
  }
  const [min, hour, dom, month, dow] = parsed as { values: Set<number>; any: boolean }[];
  if (!min || !hour || !dom || !month || !dow) return { error: 'Invalid expression.' };
  return {
    cron: {
      kind: 'fields',
      minutes: min.values,
      hours: hour.values,
      daysOfMonth: dom.values,
      months: month.values,
      daysOfWeek: dow.values,
      domAny: dom.any,
      dowAny: dow.any,
    },
  };
}

function dayMatches(cron: ParsedCron, day: Date): boolean {
  if (!cron.months.has(day.getUTCMonth() + 1)) return false;
  const domOk = cron.daysOfMonth.has(day.getUTCDate());
  const dowOk = cron.daysOfWeek.has(day.getUTCDay());
  // As robfig/cron does: when either field is a star the other decides, otherwise either may.
  return cron.domAny || cron.dowAny ? domOk && dowOk : domOk || dowOk;
}

/**
 * The next `count` instants after `from` (UTC). For `@every` they are spaced from `from`,
 * which is only an approximation: Velero counts from its own previous run.
 * An expression that never matches, such as `0 0 31 2 *`, gives an empty list.
 */
export function nextRuns(cron: Cron, from: Date, count: number): Date[] {
  if (cron.kind === 'every') {
    return Array.from(
      { length: count },
      (_, i) => new Date(from.getTime() + cron.seconds * 1000 * (i + 1)),
    );
  }
  const out: Date[] = [];
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  const hours = [...cron.hours].sort((a, b) => a - b);
  const minutes = [...cron.minutes].sort((a, b) => a - b);
  // Eight years covers a 29 February schedule.
  for (let d = 0; d < 366 * 8 && out.length < count; d += 1) {
    const day = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + d),
    );
    if (!dayMatches(cron, day)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const at = new Date(
          Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m),
        );
        if (at.getTime() > from.getTime() && out.length < count) out.push(at);
      }
    }
  }
  return out;
}

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
