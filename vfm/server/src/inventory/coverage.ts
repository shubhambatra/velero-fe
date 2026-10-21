/**
 * Which namespaces a backup covers, and how recently (PLAN.md §7.1: "last successful
 * backup covering this namespace", computed by the control plane).
 *
 * Coverage is judged by the namespace filter only: a backup that includes the
 * namespace and does not exclude it. A backup narrowed by label selectors or resource
 * lists still counts as covering it; the page says "covering", not "restorable".
 */

/** After this long without a successful backup the badge says so. */
export const STALE_AFTER_MS = 48 * 3_600_000;

export type CoverageState = 'recent' | 'stale' | 'none';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Whether a backup (or a schedule's template) spec covers `namespace`. */
export function coversNamespace(spec: unknown, namespace: string): boolean {
  const s = isRecord(spec) ? spec : {};
  const included = names(s.includedNamespaces);
  const all = included.length === 0 || included.includes('*');
  if (names(s.excludedNamespaces).includes(namespace)) {
    return false;
  }
  return all || included.includes(namespace);
}

export interface CoverageBackup {
  name: string;
  spec: unknown;
  completedAt: Date | null;
}

export interface CoverageSchedule {
  spec: unknown;
}

export interface Coverage {
  state: CoverageState;
  /** When the newest successful backup covering the namespace finished. */
  lastBackupAt: Date | null;
  /** Its name; only for a caller allowed to see that backup. */
  lastBackupName: string | null;
  /** An enabled, unpaused schedule covers the namespace. */
  scheduled: boolean;
}

/**
 * `backups` must be the successful ones, newest first. `mayName` says whether the caller
 * may be told a backup's name (a backup that reaches namespaces they cannot see is not
 * theirs to read about; the time it finished is not a secret about a namespace they can).
 */
export function coverageOf(
  namespace: string,
  backups: readonly CoverageBackup[],
  schedules: readonly CoverageSchedule[],
  now: Date,
  mayName: (backup: CoverageBackup) => boolean = () => true,
): Coverage {
  const last = backups.find((b) => b.completedAt !== null && coversNamespace(b.spec, namespace));
  const scheduled = schedules.some((s) => {
    const spec = isRecord(s.spec) ? s.spec : {};
    return spec.paused !== true && coversNamespace(spec.template, namespace);
  });
  if (last?.completedAt === undefined || last.completedAt === null) {
    return { state: 'none', lastBackupAt: null, lastBackupName: null, scheduled };
  }
  const age = now.getTime() - last.completedAt.getTime();
  return {
    state: age > STALE_AFTER_MS ? 'stale' : 'recent',
    lastBackupAt: last.completedAt,
    lastBackupName: mayName(last) ? last.name : null,
    scheduled,
  };
}

/**
 * `coverageOf` for many namespaces at once. Same answers, but each backup and schedule spec is read
 * once instead of once per namespace: at thousands of namespaces and backups the per-namespace scan
 * was the whole cost of the coverage report. `backups` must be the successful ones, newest first.
 */
export function coverageOfMany(
  namespaces: readonly string[],
  backups: readonly CoverageBackup[],
  schedules: readonly CoverageSchedule[],
  now: Date,
  mayName: (backup: CoverageBackup) => boolean = () => true,
): Map<string, Coverage> {
  const wanted = new Set(namespaces);
  const lastBy = new Map<string, CoverageBackup>();
  const scheduled = new Set<string>();

  // For each spec, the namespaces of `wanted` that it covers.
  const reach = (spec: unknown, visit: (ns: string) => void): void => {
    const s = isRecord(spec) ? spec : {};
    const included = names(s.includedNamespaces);
    const excluded = new Set(names(s.excludedNamespaces));
    const all = included.length === 0 || included.includes('*');
    for (const ns of all ? wanted : included) {
      if (wanted.has(ns) && !excluded.has(ns)) {
        visit(ns);
      }
    }
  };

  for (const backup of backups) {
    if (backup.completedAt === null) {
      continue;
    }
    if (lastBy.size === wanted.size) {
      break;
    }
    reach(backup.spec, (ns) => {
      if (!lastBy.has(ns)) lastBy.set(ns, backup);
    });
  }
  for (const schedule of schedules) {
    const spec = isRecord(schedule.spec) ? schedule.spec : {};
    if (spec.paused === true || scheduled.size === wanted.size) {
      continue;
    }
    reach(spec.template, (ns) => {
      scheduled.add(ns);
    });
  }

  const out = new Map<string, Coverage>();
  for (const ns of wanted) {
    const last = lastBy.get(ns);
    const isScheduled = scheduled.has(ns);
    if (last?.completedAt === undefined || last.completedAt === null) {
      out.set(ns, {
        state: 'none',
        lastBackupAt: null,
        lastBackupName: null,
        scheduled: isScheduled,
      });
      continue;
    }
    const age = now.getTime() - last.completedAt.getTime();
    out.set(ns, {
      state: age > STALE_AFTER_MS ? 'stale' : 'recent',
      lastBackupAt: last.completedAt,
      lastBackupName: mayName(last) ? last.name : null,
      scheduled: isScheduled,
    });
  }
  return out;
}
