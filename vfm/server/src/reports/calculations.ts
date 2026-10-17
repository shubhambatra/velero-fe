/**
 * The arithmetic of the reports (PLAN.md §16 day 34), with no I/O so that every number can be
 * checked by hand. All times are UTC; buckets are UTC days or weeks (weeks start on Monday).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type Bucket = 'day' | 'week';

/** The start of the day, or of the Monday-based week, that contains `t`. */
export function bucketStart(t: Date, bucket: Bucket): Date {
  const day = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  if (bucket === 'day') {
    return new Date(day);
  }
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - sinceMonday * DAY);
}

export const nextBucket = (start: Date, bucket: Bucket): Date =>
  new Date(start.getTime() + (bucket === 'day' ? DAY : 7 * DAY));

// ---------------------------------------------------------------- success rate

export interface FinishedBackup {
  clusterId: string;
  phase: string | null;
  /** When it finished. */
  at: Date;
}

export interface RatePoint {
  /** Start of the bucket. */
  start: string;
  completed: number;
  partiallyFailed: number;
  failed: number;
  /** completed / (completed + partiallyFailed + failed); null when nothing finished. */
  rate: number | null;
}

type Outcome = 'completed' | 'partiallyFailed' | 'failed';

/** Phases that mean a backup finished, and how it counts. Anything else (still running, deleting) is not an outcome. */
const OUTCOME: Record<string, Outcome> = {
  Completed: 'completed',
  PartiallyFailed: 'partiallyFailed',
  Failed: 'failed',
  FailedValidation: 'failed',
};

const rateOf = (c: number, p: number, f: number): number | null =>
  c + p + f === 0 ? null : c / (c + p + f);

/**
 * One point per bucket from `from` to `to` (empty buckets included, so a chart has no holes),
 * counting the backups that finished in [from, to).
 */
export function successRate(
  backups: readonly FinishedBackup[],
  from: Date,
  to: Date,
  bucket: Bucket,
): RatePoint[] {
  const points = new Map<number, { c: number; p: number; f: number }>();
  for (let s = bucketStart(from, bucket); s.getTime() < to.getTime(); s = nextBucket(s, bucket)) {
    points.set(s.getTime(), { c: 0, p: 0, f: 0 });
  }
  for (const b of backups) {
    const outcome = b.phase === null ? undefined : OUTCOME[b.phase];
    if (outcome === undefined || b.at < from || b.at >= to) {
      continue;
    }
    const slot = points.get(bucketStart(b.at, bucket).getTime());
    if (slot === undefined) {
      continue;
    }
    if (outcome === 'completed') slot.c += 1;
    else if (outcome === 'partiallyFailed') slot.p += 1;
    else slot.f += 1;
  }
  return [...points.entries()].map(([start, v]) => ({
    start: new Date(start).toISOString(),
    completed: v.c,
    partiallyFailed: v.p,
    failed: v.f,
    rate: rateOf(v.c, v.p, v.f),
  }));
}

export function totals(points: readonly RatePoint[]): Omit<RatePoint, 'start'> {
  const c = points.reduce((n, p) => n + p.completed, 0);
  const pf = points.reduce((n, p) => n + p.partiallyFailed, 0);
  const f = points.reduce((n, p) => n + p.failed, 0);
  return { completed: c, partiallyFailed: pf, failed: f, rate: rateOf(c, pf, f) };
}

/** Adds several clusters' series, bucket by bucket (they share the same buckets). */
export function sumSeries(series: readonly (readonly RatePoint[])[]): RatePoint[] {
  const first = series[0];
  if (first === undefined) {
    return [];
  }
  return first.map((point, i) => {
    let c = 0;
    let p = 0;
    let f = 0;
    for (const s of series) {
      c += s[i]?.completed ?? 0;
      p += s[i]?.partiallyFailed ?? 0;
      f += s[i]?.failed ?? 0;
    }
    return {
      start: point.start,
      completed: c,
      partiallyFailed: p,
      failed: f,
      rate: rateOf(c, p, f),
    };
  });
}

// ------------------------------------------------------------------ RPO

export interface RpoResult {
  /** Time inside the objective, as a share of the measured time; null when nothing was measured. */
  compliance: number | null;
  measuredHours: number;
  compliantHours: number;
  /** The longest the newest backup was ever older than at once, in hours, including now. */
  longestGapHours: number;
  /** Successful backups that finished inside the window. */
  successes: number;
  lastSuccessAt: string | null;
  /** Age of the newest successful backup at `to`; null when there has never been one. */
  ageHours: number | null;
  /** The objective holds at `to`. */
  metNow: boolean;
}

/**
 * RPO compliance of one schedule over [from, to]: the share of the time that the newest
 * successful backup was no older than `targetMs`.
 *
 * At each instant the age is the time since the last success. Between two successes `a` and
 * `b` it grows from 0 to b − a, so the objective holds for the first `target` of that stretch
 * and not for the rest. Measurement starts at `from`, or at the schedule's creation if later;
 * with no success before the start, the creation counts as the starting point, which gives a
 * new schedule one full objective to make its first backup. Without a creation time the start
 * is taken as a success.
 *
 * `successes` are the finish times of every successful backup of the schedule, in any order.
 */
export function rpoCompliance(
  successes: readonly Date[],
  from: Date,
  to: Date,
  targetMs: number,
  createdAt: Date | null,
): RpoResult {
  const end = to.getTime();
  const start = Math.max(from.getTime(), createdAt?.getTime() ?? from.getTime());
  const times = successes.map((d) => d.getTime()).sort((a, b) => a - b);
  const before = times.filter((t) => t <= start);
  const within = times.filter((t) => t > start && t <= end);
  const anchor = before.at(-1) ?? (createdAt === null ? start : createdAt.getTime());

  let compliant = 0;
  let longest = 0;
  let a = anchor;
  for (const b of [...within, end]) {
    const from_ = Math.max(a, start);
    compliant += Math.max(0, Math.min(b, a + targetMs) - from_);
    longest = Math.max(longest, b - a);
    a = b;
  }
  const total = Math.max(0, end - start);
  const last = times.filter((t) => t <= end).at(-1);
  return {
    compliance: total === 0 ? null : compliant / total,
    measuredHours: total / HOUR,
    compliantHours: compliant / HOUR,
    longestGapHours: longest / HOUR,
    successes: within.length,
    lastSuccessAt: last === undefined ? null : new Date(last).toISOString(),
    ageHours: last === undefined ? null : (end - last) / HOUR,
    metNow: end - (last ?? anchor) <= targetMs,
  };
}

// ------------------------------------------------------------------ coverage

export interface StaleNamespace {
  namespace: string;
  lastBackupAt: string | null;
  /** Hours since the last successful backup covering it; null when there has never been one. */
  hoursSince: number | null;
  scheduled: boolean;
}

/** Namespaces whose newest successful covering backup is older than `hours`, or that have none; the longest-neglected first. */
export function staleNamespaces(
  rows: readonly { namespace: string; lastBackupAt: Date | null; scheduled: boolean }[],
  hours: number,
  now: Date,
): StaleNamespace[] {
  return rows
    .map((r) => ({
      namespace: r.namespace,
      lastBackupAt: r.lastBackupAt === null ? null : r.lastBackupAt.toISOString(),
      hoursSince:
        r.lastBackupAt === null ? null : (now.getTime() - r.lastBackupAt.getTime()) / HOUR,
      scheduled: r.scheduled,
    }))
    .filter((r) => r.hoursSince === null || r.hoursSince > hours)
    .sort((a, b) => {
      if (a.hoursSince === null || b.hoursSince === null) {
        return a.hoursSince === b.hoursSince
          ? a.namespace.localeCompare(b.namespace)
          : a.hoursSince === null
            ? -1
            : 1;
      }
      return b.hoursSince - a.hoursSince || a.namespace.localeCompare(b.namespace);
    });
}
