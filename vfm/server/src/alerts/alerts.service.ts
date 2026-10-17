import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { newId } from '../common/uuid';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import {
  evaluate,
  type BackupRow,
  type BslRow,
  type ClusterFacts,
  type Condition,
  type ScheduleRow,
} from './conditions';
import { AlertNotifier, type NotificationKind } from './notifier';
import { scopeSchema } from './rule-params';

/** Backups read per cluster per evaluation: the newest, which is where every rule looks. */
const BACKUPS_PER_CLUSTER = 5000;

const MINUTE = 60_000;

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface EvaluationSummary {
  orgs: number;
  fired: number;
  resolved: number;
  renotified: number;
}

/**
 * The alert engine (PLAN.md §16 day 32).
 *
 * It does not react to events; it looks. On each evaluation it works out, for every enabled
 * rule and every cluster the rule covers, what is wrong *now*, and compares that with the
 * open `alert_events`. A condition that is new fires, one that is gone resolves, one that
 * stays is left alone until its re-notify interval passes. Because the answer is computed from
 * the current state, a restart, a missed tick or a second replica cannot lose or duplicate an
 * alert — the worst case is a late one.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: AlertNotifier,
    @Inject(ENV) _env: Env,
  ) {}

  /** Every org that has an enabled rule, evaluated in turn. */
  async evaluateAll(now: Date = new Date()): Promise<EvaluationSummary> {
    const orgs = await this.prisma.unscoped('the alert evaluator spans every org', () =>
      this.prisma.alertRule.findMany({
        where: { enabled: true },
        distinct: ['orgId'],
        select: { orgId: true },
      }),
    );
    // Open events whose rules have all been disabled still need closing.
    const withOpen = await this.prisma.unscoped('the alert evaluator spans every org', () =>
      this.prisma.alertEvent.findMany({
        where: { state: 'FIRING' },
        distinct: ['orgId'],
        select: { orgId: true },
      }),
    );
    const ids = new Set([...orgs, ...withOpen].map((o) => o.orgId));
    const total: EvaluationSummary = { orgs: 0, fired: 0, resolved: 0, renotified: 0 };
    for (const orgId of ids) {
      try {
        const one = await this.evaluateOrg(orgId, now);
        total.orgs += 1;
        total.fired += one.fired;
        total.resolved += one.resolved;
        total.renotified += one.renotified;
      } catch (error: unknown) {
        // One org's trouble must not stop the others being watched.
        this.logger.warn(
          `alert evaluation failed for an org: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
    return total;
  }

  async evaluateOrg(
    orgId: string,
    now: Date = new Date(),
  ): Promise<Omit<EvaluationSummary, 'orgs'>> {
    return this.prisma.inOrg(orgId, async () => {
      const [rules, open, clusters] = await Promise.all([
        this.prisma.alertRule.findMany({ where: { orgId, enabled: true } }),
        this.prisma.alertEvent.findMany({ where: { orgId, state: 'FIRING' } }),
        this.prisma.cluster.findMany({
          where: { orgId },
          select: { id: true, name: true, status: true, lastSeenAt: true },
        }),
      ]);
      const facts = await this.loadFacts(orgId, clusters, now);
      const ruleById = new Map(rules.map((r) => [r.id, r]));
      const summary = { fired: 0, resolved: 0, renotified: 0 };
      const seen = new Set<string>();

      for (const rule of rules) {
        const scope = scopeSchema.safeParse(rule.scope);
        const wanted = scope.success ? scope.data.clusterIds : [];
        const params = record(rule.params);
        const channelIds = Array.isArray(rule.channelIds)
          ? rule.channelIds.filter((c): c is string => typeof c === 'string')
          : [];
        for (const cluster of facts) {
          if (wanted.length > 0 && !wanted.includes(cluster.id)) {
            continue;
          }
          const found = evaluate(rule.type, cluster, params, now);
          for (const condition of found) {
            const key = `${rule.id}\u0000${condition.fingerprint}\u0000${cluster.id}`;
            seen.add(key);
            const existing = open.find(
              (e) =>
                e.ruleId === rule.id &&
                e.clusterId === cluster.id &&
                e.fingerprint === condition.fingerprint,
            );
            if (existing === undefined) {
              if (await this.fire(orgId, rule, condition, channelIds, now)) summary.fired += 1;
            } else if (await this.keep(orgId, rule, existing, condition, channelIds, params, now)) {
              summary.renotified += 1;
            }
          }
        }
      }

      for (const event of open) {
        const rule = ruleById.get(event.ruleId);
        const key = `${event.ruleId}\u0000${event.fingerprint}\u0000${event.clusterId}`;
        if (seen.has(key)) continue;
        // Gone: the condition ended, or the rule was disabled or no longer covers the cluster.
        // Only the first is news worth a message, and only to people who heard it start.
        const ended = rule !== undefined && this.covers(rule.scope, event.clusterId);
        await this.resolve(orgId, event, ended ? rule : undefined, now);
        summary.resolved += 1;
      }
      return summary;
    });
  }

  private covers(scope: unknown, clusterId: string): boolean {
    const parsed = scopeSchema.safeParse(scope);
    return (
      !parsed.success ||
      parsed.data.clusterIds.length === 0 ||
      parsed.data.clusterIds.includes(clusterId)
    );
  }

  private async fire(
    orgId: string,
    rule: { id: string; name: string; type: string },
    condition: Condition,
    channelIds: string[],
    now: Date,
  ): Promise<boolean> {
    let created;
    try {
      created = await this.prisma.alertEvent.create({
        data: {
          id: newId(),
          orgId,
          ruleId: rule.id,
          clusterId: condition.clusterId,
          state: 'FIRING',
          fingerprint: condition.fingerprint,
          payload: condition.payload,
          firedAt: now,
        },
      });
    } catch (error: unknown) {
      // Another replica fired it first: the partial unique index is what makes that safe.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
    if (channelIds.length > 0) {
      await this.deliver('fired', orgId, rule, created, channelIds, now);
    }
    return true;
  }

  /** A condition that is still true: refresh what it says, and repeat it when its interval is up. */
  private async keep(
    orgId: string,
    rule: { id: string; name: string; type: string },
    event: {
      id: string;
      clusterId: string;
      fingerprint: string;
      firedAt: Date;
      lastNotifiedAt: Date | null;
      payload: Prisma.JsonValue;
    },
    condition: Condition,
    channelIds: string[],
    params: Record<string, unknown>,
    now: Date,
  ): Promise<boolean> {
    const changed = JSON.stringify(event.payload) !== JSON.stringify(condition.payload);
    if (changed) {
      await this.prisma.alertEvent.update({
        where: { id: event.id },
        data: { payload: condition.payload },
      });
    }
    if (channelIds.length === 0) return false;
    const every = typeof params.renotifyMinutes === 'number' ? params.renotifyMinutes : 240;
    // Never told (no channel when it started, or the last attempt failed): tell now.
    const never = event.lastNotifiedAt === null;
    const due =
      event.lastNotifiedAt === null ||
      (every > 0 && now.getTime() - event.lastNotifiedAt.getTime() >= every * MINUTE);
    if (!due) return false;
    await this.deliver(
      never ? 'fired' : 'renotify',
      orgId,
      rule,
      { ...event, payload: condition.payload },
      channelIds,
      now,
    );
    return true;
  }

  private async resolve(
    orgId: string,
    event: {
      id: string;
      ruleId: string;
      clusterId: string;
      fingerprint: string;
      firedAt: Date;
      lastNotifiedAt: Date | null;
      payload: Prisma.JsonValue;
    },
    rule: { id: string; name: string; type: string; channelIds: Prisma.JsonValue } | undefined,
    now: Date,
  ): Promise<void> {
    const result = await this.prisma.alertEvent.updateMany({
      where: { id: event.id, state: 'FIRING' },
      data: { state: 'RESOLVED', resolvedAt: now },
    });
    if (result.count === 0 || rule === undefined || event.lastNotifiedAt === null) return;
    const channelIds = Array.isArray(rule.channelIds)
      ? rule.channelIds.filter((c): c is string => typeof c === 'string')
      : [];
    if (channelIds.length === 0) return;
    await this.deliver('resolved', orgId, rule, { ...event, resolvedAt: now }, channelIds, now);
  }

  private async deliver(
    kind: NotificationKind,
    orgId: string,
    rule: { id: string; name: string; type: string },
    event: {
      id: string;
      clusterId: string;
      fingerprint: string;
      firedAt: Date;
      payload: Prisma.JsonValue;
      resolvedAt?: Date | null;
    },
    channelIds: string[],
    now: Date,
  ): Promise<void> {
    try {
      await this.notifier.notify({
        kind,
        orgId,
        rule: { id: rule.id, name: rule.name, type: rule.type },
        event: {
          id: event.id,
          clusterId: event.clusterId,
          fingerprint: event.fingerprint,
          payload: record(event.payload),
          firedAt: event.firedAt,
          resolvedAt: event.resolvedAt ?? null,
        },
        channelIds,
      });
    } catch (error: unknown) {
      // Not taken over: leave `lastNotifiedAt` as it was so the next evaluation offers it again.
      this.logger.warn(
        `alert ${kind} was not delivered: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return;
    }
    await this.prisma.alertEvent.update({ where: { id: event.id }, data: { lastNotifiedAt: now } });
  }

  private async loadFacts(
    orgId: string,
    clusters: { id: string; name: string; status: string; lastSeenAt: Date | null }[],
    _now: Date,
  ): Promise<ClusterFacts[]> {
    const out: ClusterFacts[] = [];
    for (const cluster of clusters) {
      const [backups, schedules, locations] = await Promise.all([
        this.prisma.veleroResource.findMany({
          where: { orgId, clusterId: cluster.id, kind: 'BACKUP', deletedAt: null },
          orderBy: { creationTimestamp: 'desc' },
          take: BACKUPS_PER_CLUSTER,
          select: {
            name: true,
            namespace: true,
            phase: true,
            labels: true,
            status: true,
            startedAt: true,
            completedAt: true,
            creationTimestamp: true,
            expiresAt: true,
          },
        }),
        this.prisma.veleroResource.findMany({
          where: { orgId, clusterId: cluster.id, kind: 'SCHEDULE', deletedAt: null },
          select: {
            name: true,
            namespace: true,
            spec: true,
            status: true,
            creationTimestamp: true,
          },
        }),
        this.prisma.veleroResource.findMany({
          where: {
            orgId,
            clusterId: cluster.id,
            kind: 'BACKUP_STORAGE_LOCATION',
            deletedAt: null,
          },
          select: { name: true, namespace: true, phase: true },
        }),
      ]);
      out.push({
        ...cluster,
        backups: backups.map((b): BackupRow => ({
          name: b.name,
          namespace: b.namespace,
          phase: b.phase,
          schedule: text(record(b.labels)['velero.io/schedule-name']),
          at: b.completedAt ?? b.startedAt ?? b.creationTimestamp,
          expiresAt: b.expiresAt,
          failureReason: text(record(b.status).failureReason)?.slice(0, 300) ?? null,
        })),
        schedules: schedules.map((s): ScheduleRow => ({
          name: s.name,
          namespace: s.namespace,
          cron: text(record(s.spec).schedule),
          paused: record(s.spec).paused === true,
          createdAt: s.creationTimestamp,
          lastBackupAt: date(record(s.status).lastBackup),
        })),
        locations: locations.map((l): BslRow => ({ ...l })),
      });
    }
    return out;
  }

  // -------------------------------------------------------------- rules and history

  async getRule(orgId: string, ruleId: string) {
    const rule = await this.prisma.inOrg(orgId, () =>
      this.prisma.alertRule.findFirst({ where: { id: ruleId, orgId } }),
    );
    if (rule === null) throw new NotFoundException('alert rule not found');
    return rule;
  }
}
