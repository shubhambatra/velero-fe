/** The reports as the control plane returns them (PLAN.md §16 day 34). */

export interface RatePoint {
  start: string;
  completed: number;
  partiallyFailed: number;
  failed: number;
  rate: number | null;
}
export type RateTotals = Omit<RatePoint, 'start'>;

export interface SuccessRateReport {
  from: string;
  to: string;
  bucket: 'day' | 'week';
  clusters: { clusterId: string; clusterName: string; points: RatePoint[]; totals: RateTotals }[];
  all: { points: RatePoint[]; totals: RateTotals };
  incomplete: boolean;
}

export interface StaleNamespace {
  namespace: string;
  lastBackupAt: string | null;
  hoursSince: number | null;
  scheduled: boolean;
}

export interface CoverageReport {
  hours: number;
  generatedAt: string;
  clusters: {
    clusterId: string;
    clusterName: string;
    namespaces: StaleNamespace[];
    total: number;
  }[];
  incomplete: boolean;
}

export interface RpoRow {
  clusterId: string;
  clusterName: string;
  schedule: string;
  cron: string | null;
  targetHours: number;
  compliance: number | null;
  measuredHours: number;
  compliantHours: number;
  longestGapHours: number;
  successes: number;
  lastSuccessAt: string | null;
  ageHours: number | null;
  metNow: boolean;
}

export interface RpoReport {
  from: string;
  to: string;
  schedules: RpoRow[];
  incomplete: boolean;
}

export const RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
] as const;

/** "97.5 %", or an em dash when there is nothing to divide. */
export const percent = (v: number | null): string =>
  v === null ? '—' : `${(Math.round(v * 1000) / 10).toString()} %`;

/** "3 d 4 h" for long spans, "5.5 h" for short ones. */
export function duration(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 48) return `${(Math.round(hours * 10) / 10).toString()} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours - days * 24);
  return rest === 0 ? `${days.toString()} d` : `${days.toString()} d ${rest.toString()} h`;
}

export function windowQuery(days: number, now: Date = new Date()): string {
  const to = now;
  const from = new Date(to.getTime() - days * 86_400_000);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}
