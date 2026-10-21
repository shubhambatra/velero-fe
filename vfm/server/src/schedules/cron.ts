/**
 * Whether a schedule expression is one Velero can read: the five-field form (minute
 * hour day-of-month month day-of-week), `@yearly` and its siblings, or `@every <duration>`.
 * A schedule Velero cannot parse ends in `FailedValidation` and never runs, so the API
 * refuses it now. The agent checks again with the same rules (`agent/internal/velero/cron.go`).
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DESCRIPTORS = new Set([
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
]);

interface FieldRule {
  name: string;
  lo: number;
  hi: number;
  /** Name → value, e.g. `jan` → 1. */
  names?: readonly string[];
  nameBase?: number;
  allowAny: boolean;
}

const FIELDS: FieldRule[] = [
  { name: 'minute', lo: 0, hi: 59, allowAny: false },
  { name: 'hour', lo: 0, hi: 23, allowAny: false },
  { name: 'day of month', lo: 1, hi: 31, allowAny: true },
  { name: 'month', lo: 1, hi: 12, names: MONTHS, nameBase: 1, allowAny: false },
  { name: 'day of week', lo: 0, hi: 6, names: WEEKDAYS, nameBase: 0, allowAny: true },
];

/** A message when `expr` is not a valid schedule, otherwise `undefined`. */
export function cronProblem(expr: string): string | undefined {
  const text = expr.trim();
  if (text === '') {
    return 'a cron expression is required';
  }
  if (text.startsWith('@')) {
    if (DESCRIPTORS.has(text)) {
      return undefined;
    }
    const every = /^@every\s+(.+)$/.exec(text);
    if (every !== null) {
      return everySeconds(every[1] ?? '') >= 1
        ? undefined
        : '@every needs a duration of at least one second, such as "@every 6h"';
    }
    return `unknown descriptor "${text}"`;
  }
  const parts = text.split(/\s+/);
  if (parts.length !== 5) {
    return `a cron expression has five fields (minute hour day-of-month month day-of-week), found ${parts.length.toString()}`;
  }
  for (const [i, part] of parts.entries()) {
    const rule = FIELDS[i];
    const problem = rule === undefined ? undefined : fieldProblem(part, rule);
    if (problem !== undefined) {
      return `${rule?.name ?? 'field'}: ${problem}`;
    }
  }
  return undefined;
}

/** Seconds in a Go-style duration, or `NaN`. */
function everySeconds(text: string): number {
  if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(text.trim())) {
    return Number.NaN;
  }
  const units: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    µs: 1e-6,
    ms: 1e-3,
    s: 1,
    m: 60,
    h: 3600,
  };
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    total += Number(m[1]) * (units[m[2] ?? 's'] ?? 0);
  }
  return total;
}

function value(text: string, rule: FieldRule): number | string {
  const named = rule.names?.indexOf(text.toLowerCase()) ?? -1;
  if (named >= 0) {
    return named + (rule.nameBase ?? 0);
  }
  if (!/^\d+$/.test(text)) {
    return `"${text}" is not a number or a name`;
  }
  const n = Number(text);
  return n < rule.lo || n > rule.hi
    ? `${n.toString()} is outside ${rule.lo.toString()}–${rule.hi.toString()}`
    : n;
}

function fieldProblem(field: string, rule: FieldRule): string | undefined {
  for (const item of field.split(',')) {
    if (item === '') {
      return `empty list item in "${field}"`;
    }
    const [range = '', step, ...extra] = item.split('/');
    if (extra.length > 0) {
      return `"${item}" has more than one step`;
    }
    if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1)) {
      return `step "${step}" must be a positive number`;
    }
    if (range === '*' || (rule.allowAny && range === '?')) {
      continue;
    }
    const [a = '', b, ...more] = range.split('-');
    if (more.length > 0) {
      return `"${range}" is not a range`;
    }
    const lo = value(a, rule);
    if (typeof lo === 'string') {
      return lo;
    }
    if (b !== undefined) {
      const hi = value(b, rule);
      if (typeof hi === 'string') {
        return hi;
      }
      if (hi < lo) {
        return `range "${range}" runs backwards`;
      }
    }
  }
  return undefined;
}
