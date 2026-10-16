import { z } from 'zod';

import {
  createBackupBody,
  createCoverage,
  checkDurations,
  OBJECT_NAME,
  toBackupSpec,
  type Coverage,
} from '../backups/backup-request';
import type { Command } from '../gateway/pb/vfm/agent/v1/command';
import type { ScheduleSpec } from '../gateway/pb/vfm/agent/v1/velero';
import { cronProblem } from './cron';

/**
 * The API bodies of `POST/PUT …/schedules` and how they become the protobuf the agent
 * receives (PLAN.md §5.2, §6).
 *
 * A schedule embeds a backup spec, so its template accepts exactly the fields of
 * `velero backup create` and is as strict. The name is limited to 48 characters: the
 * backups a schedule makes are named `<schedule>-<14-digit timestamp>` and a backup name
 * must fit a 63-character label.
 */

export const MAX_SCHEDULE_NAME = 48;

export const scheduleName = z.string().max(MAX_SCHEDULE_NAME).regex(OBJECT_NAME);

/** What a schedule's template may say: a backup, minus the things a schedule decides. */
const template = createBackupBody.omit({ name: true, advancedSpec: true });

const scheduleFields = {
  /** Cron: five fields, `@daily`-style descriptors or `@every 6h`. Velero reads it in its own time zone, normally UTC. */
  schedule: z.string().max(200),
  template,
  paused: z.boolean().optional(),
  skipImmediately: z.boolean().optional(),
  useOwnerReferencesInBackup: z.boolean().optional(),
  /** Merged onto the template (hooks and the like); validated by the agent against Velero's type. */
  advancedSpec: z.record(z.string(), z.unknown()).optional(),
};

export const createScheduleBody = z.object({ name: scheduleName, ...scheduleFields }).strict();

export const updateScheduleBody = z.object(scheduleFields).strict();

export const pauseBody = z.object({ paused: z.boolean() }).strict();

export type CreateScheduleBody = z.infer<typeof createScheduleBody>;
export type UpdateScheduleBody = z.infer<typeof updateScheduleBody>;

/** A message when the body is out of range (a cron Velero cannot read, a zero TTL). */
export function checkSchedule(body: UpdateScheduleBody): string | undefined {
  const cron = cronProblem(body.schedule);
  if (cron !== undefined) {
    return `schedule: ${cron}`;
  }
  return checkDurations(body.template);
}

/** What the backups a schedule template makes would reach. */
export function templateCoverage(spec: unknown): Coverage {
  const t = (
    typeof spec === 'object' && spec !== null && 'template' in spec ? spec.template : undefined
  ) as Record<string, unknown> | undefined;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return createCoverage({
    includedNamespaces: list(t?.includedNamespaces),
    includeClusterResources:
      typeof t?.includeClusterResources === 'boolean' ? t.includeClusterResources : undefined,
    includedClusterScopedResources: list(t?.includedClusterScopedResources),
  });
}

export function toScheduleSpec(body: UpdateScheduleBody): ScheduleSpec {
  return {
    template: toBackupSpec(body.template),
    schedule: body.schedule.trim(),
    useOwnerReferencesInBackup: body.useOwnerReferencesInBackup,
    paused: body.paused ?? false,
    skipImmediately: body.skipImmediately,
  };
}

const advancedBytes = (body: UpdateScheduleBody): Uint8Array =>
  body.advancedSpec === undefined
    ? new Uint8Array()
    : Buffer.from(JSON.stringify(body.advancedSpec));

/** The `Command` arm for a stored `CREATE_SCHEDULE` payload. Re-validates: the row is data, not trust. */
export function buildCreateSchedule(payload: Record<string, unknown>): Partial<Command> {
  const body = createScheduleBody.parse(payload);
  return {
    createSchedule: {
      name: body.name,
      spec: toScheduleSpec(body),
      advancedSpecJson: advancedBytes(body),
    },
  };
}

export function buildUpdateSchedule(payload: Record<string, unknown>): Partial<Command> {
  const { name, ...rest } = payload;
  const body = updateScheduleBody.parse(rest);
  return {
    updateSchedule: {
      name: scheduleName.parse(name),
      spec: toScheduleSpec(body),
      advancedSpecJson: advancedBytes(body),
    },
  };
}

export function buildSetSchedulePaused(payload: Record<string, unknown>): Partial<Command> {
  return {
    setSchedulePaused: {
      name: z.string().max(63).regex(OBJECT_NAME).parse(payload.name),
      paused: z.boolean().parse(payload.paused),
    },
  };
}
