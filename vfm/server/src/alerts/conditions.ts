import { longestGapSeconds, parseCron } from '@vfm/shared';

import type { AlertRuleType } from './rule-params';

/** One thing that is wrong right now. The fingerprint is what makes it the same thing next time. */
export interface Condition {
  clusterId: string;
  fingerprint: string;
  /** What a notification says. Names and times only: no spec, no log, nothing a user typed freely. */
  payload: Record<string, string | number | boolean | null>;
}

export interface BackupRow {
  name: string;
  namespace: string;
  phase: string | null;
  schedule: string | null;
  at: Date | null;
  expiresAt: Date | null;
  failureReason: string | null;
}

export interface ScheduleRow {
  name: string;
  namespace: string;
  cron: string | null;
  paused: boolean;
  createdAt: Date | null;
  /** `status.lastBackup`, when Velero recorded one. */
  lastBackupAt: Date | null;
}

export interface BslRow {
  name: string;
  namespace: string;
  phase: string | null;
}

export interface ClusterFacts {
  id: string;
  name: string;
  status: string;
  lastSeenAt: Date | null;
  backups: BackupRow[];
  schedules: ScheduleRow[];
  locations: BslRow[];
}

const FAILED = new Set(['Failed', 'FailedValidation']);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const newest = (a: Date | null, b: Date | null): Date | null =>
  a === null ? b : b === null ? a : a > b ? a : b;

/** Backups of one schedule, or one backup on its own. */
const groupOf = (b: BackupRow): string => b.schedule ?? b.name;

function groupBackups(backups: readonly BackupRow[]): Map<string, BackupRow[]> {
  const groups = new Map<string, BackupRow[]>();
  for (const b of backups) {
    const key = `${b.namespace}/${groupOf(b)}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  return groups;
}

/**
 * A backup, or a schedule's backups, whose latest failed run has not since been followed by a
 * completed one. Fixed means a newer Completed backup of the same schedule; an ad-hoc backup
 * has no successor, so it stops counting when it falls out of the lookback window.
 */
export function backupFailed(
  facts: ClusterFacts,
  params: { lookbackHours: number; includePartiallyFailed: boolean },
  now: Date,
): Condition[] {
  const since = now.getTime() - params.lookbackHours * HOUR;
  const out: Condition[] = [];
  for (const [key, group] of groupBackups(facts.backups)) {
    const timed = group
      .filter((b) => b.at !== null)
      .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
    const bad = timed.filter(
      (b) =>
        b.phase !== null &&
        (FAILED.has(b.phase) || (params.includePartiallyFailed && b.phase === 'PartiallyFailed')),
    );
    const last = bad.at(-1);
    if (last === undefined || (last.at as Date).getTime() < since) {
      continue;
    }
    const fixed = timed.some((b) => b.phase === 'Completed' && (b.at as Date) > (last.at as Date));
    if (fixed) {
      continue;
    }
    out.push({
      clusterId: facts.id,
      fingerprint: `backup-failed:${key}`,
      payload: {
        cluster: facts.name,
        backup: last.name,
        namespace: last.namespace,
        schedule: last.schedule,
        phase: last.phase,
        failedAt: iso(last.at),
        reason: last.failureReason,
      },
    });
  }
  return out;
}

/** A schedule that has not produced a backup within `factor` times its longest interval. */
export function scheduleMissed(
  facts: ClusterFacts,
  params: { factor: number },
  now: Date,
): Condition[] {
  const out: Condition[] = [];
  for (const schedule of facts.schedules) {
    if (schedule.paused || schedule.cron === null) {
      continue;
    }
    const parsed = parseCron(schedule.cron);
    if (!('cron' in parsed)) {
      continue;
    }
    const gap = longestGapSeconds(parsed.cron, now);
    if (gap === null) {
      continue;
    }
    let last = newest(schedule.lastBackupAt, schedule.createdAt);
    for (const b of facts.backups) {
      if (b.schedule === schedule.name && b.namespace === schedule.namespace) {
        last = newest(last, b.at);
      }
    }
    if (last === null) {
      continue;
    }
    const allowedMs = gap * params.factor * 1000;
    if (now.getTime() - last.getTime() <= allowedMs) {
      continue;
    }
    out.push({
      clusterId: facts.id,
      fingerprint: `schedule-missed:${schedule.namespace}/${schedule.name}`,
      payload: {
        cluster: facts.name,
        schedule: schedule.name,
        namespace: schedule.namespace,
        cron: schedule.cron,
        lastBackupAt: iso(last),
        allowedHours: Math.round((allowedMs / HOUR) * 10) / 10,
      },
    });
  }
  return out;
}

/** An agent that was seen once and has not been for `minutes`. A cluster never connected has nothing to lose. */
export function agentDisconnected(
  facts: ClusterFacts,
  params: { minutes: number },
  now: Date,
): Condition[] {
  if (['PENDING', 'DISABLED', 'CONNECTED'].includes(facts.status) || facts.lastSeenAt === null) {
    return [];
  }
  const away = now.getTime() - facts.lastSeenAt.getTime();
  if (away < params.minutes * MINUTE) {
    return [];
  }
  return [
    {
      clusterId: facts.id,
      fingerprint: 'agent-disconnected',
      payload: {
        cluster: facts.name,
        lastSeenAt: iso(facts.lastSeenAt),
        minutes: Math.floor(away / MINUTE),
      },
    },
  ];
}

/** A backup storage location Velero reports as Unavailable. */
export function bslUnavailable(facts: ClusterFacts): Condition[] {
  return facts.locations
    .filter((l) => l.phase === 'Unavailable')
    .map((l) => ({
      clusterId: facts.id,
      fingerprint: `bsl-unavailable:${l.namespace}/${l.name}`,
      payload: { cluster: facts.name, location: l.name, namespace: l.namespace },
    }));
}

/**
 * The newest completed backup of a schedule (or one on its own) is about to expire and nothing
 * newer exists to take its place.
 */
export function backupExpiring(
  facts: ClusterFacts,
  params: { withinDays: number },
  now: Date,
): Condition[] {
  const horizon = now.getTime() + params.withinDays * DAY;
  const out: Condition[] = [];
  for (const [key, group] of groupBackups(facts.backups)) {
    const done = group
      .filter((b) => b.phase === 'Completed' && b.at !== null)
      .sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());
    const last = done.at(-1);
    if (last === undefined || last.expiresAt === null || last.expiresAt.getTime() > horizon) {
      continue;
    }
    out.push({
      clusterId: facts.id,
      fingerprint: `backup-expiring:${key}`,
      payload: {
        cluster: facts.name,
        backup: last.name,
        namespace: last.namespace,
        schedule: last.schedule,
        expiresAt: iso(last.expiresAt),
        expired: last.expiresAt.getTime() <= now.getTime(),
      },
    });
  }
  return out;
}

/** What a rule of `type` finds wrong on one cluster. */
export function evaluate(
  type: AlertRuleType,
  facts: ClusterFacts,
  params: Record<string, unknown>,
  now: Date,
): Condition[] {
  switch (type) {
    case 'BACKUP_FAILED':
      return backupFailed(facts, params as Parameters<typeof backupFailed>[1], now);
    case 'SCHEDULE_MISSED':
      return scheduleMissed(facts, params as Parameters<typeof scheduleMissed>[1], now);
    case 'AGENT_DISCONNECTED':
      return agentDisconnected(facts, params as Parameters<typeof agentDisconnected>[1], now);
    case 'BSL_UNAVAILABLE':
      return bslUnavailable(facts);
    case 'BACKUP_EXPIRING':
      return backupExpiring(facts, params as Parameters<typeof backupExpiring>[1], now);
  }
}
