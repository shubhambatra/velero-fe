import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { hostname } from 'node:os';

import { AuditService } from '../audit/audit.service';
import { AUDIT_CSV_HEADER, auditCsvLine, csvRow } from '../audit/csv';
import { parseOrgSettings } from '../auth/org-mfa-policy';
import { TERMINAL } from '../commands/command-state';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { retentionDeleted, retentionRuns } from '../metrics/metrics';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { deleteAuditUpTo } from './audit-purge';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BATCH = 5_000;
const LOCK_KEY = 'vfm:retention:lock';

/** How long each kind of thing is kept (PLAN.md section 9). Tests move these; nothing else does. */
export const retention = {
  /** Kubernetes events are shown for an hour, so anything not seen for an hour is gone from the cluster. */
  eventMaxAgeMs: 1 * HOUR,
  /** Commands: 180 days (PLAN.md section 9). Only finished ones; an unfinished command is still work. */
  commandMaxAgeMs: 180 * DAY,
  /** Inventory objects the cluster no longer has. */
  deletedObjectMaxAgeMs: 7 * DAY,
  /**
   * Backups and restores that no longer exist stay longer, because the success-rate and RPO reports count a
   * backup that failed and was later deleted (they read up to 366 days back).
   */
  deletedHistoryMaxAgeMs: 400 * DAY,
  /** The default for audit events with no organization, and for an organization that has not chosen. */
  auditDefaultDays: 400,
};

export interface AuditPurge {
  orgId: string | null;
  deleted: number;
  exportedTo?: string;
  /** Why nothing was deleted for this organization, when that is the case. */
  skipped?: string;
}

export interface RetentionReport {
  at: string;
  events: number;
  softDeleted: number;
  files: number;
  commands: number;
  audit: AuditPurge[];
  /** Something was skipped or refused: the run is not complete. */
  partial: boolean;
}

/**
 * The daily retention job (PLAN.md section 9): events past their hour, cached files past their expiry,
 * commands past 180 days, audit events past each organization's setting (default 400 days, optionally
 * exported first). One replica runs it per interval, decided by a Redis key, so a restart or several
 * replicas do not run it twice.
 *
 * It spans every organization by nature, which is why its reads and deletes go through one reviewed
 * `unscoped` call site (`org-scope.test.ts`). Deletion is in batches so no statement holds a lock for long.
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.RETENTION_INTERVAL_HOURS <= 0) {
      return;
    }
    // Check often, run rarely: the Redis key decides, so a restart does not push the next run back.
    this.timer = setInterval(() => {
      this.runIfDue().catch((error: unknown) => {
        this.logger.warn(`retention failed: ${error instanceof Error ? error.message : 'unknown'}`);
      });
    }, 15 * 60_000);
    this.timer.unref();
    setTimeout(() => {
      this.runIfDue().catch(() => undefined);
    }, 2 * 60_000).unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Runs now if this interval's run has not been taken by a replica yet. */
  async runIfDue(): Promise<RetentionReport | undefined> {
    const seconds = Math.max(60, Math.round(this.env.RETENTION_INTERVAL_HOURS * 3_600) - 60);
    const taken = await this.redis.connection.set(LOCK_KEY, hostname(), 'EX', seconds, 'NX');
    if (taken !== 'OK') {
      return undefined;
    }
    return this.run();
  }

  /** One pass over everything. Safe to run at any time and to run again. */
  async run(now: Date = new Date()): Promise<RetentionReport> {
    const report: RetentionReport = {
      at: now.toISOString(),
      events: 0,
      softDeleted: 0,
      files: 0,
      commands: 0,
      audit: [],
      partial: false,
    };
    try {
      report.events = await this.sweep(
        'events',
        async (take) =>
          this.all(() =>
            this.prisma.veleroResource.findMany({
              where: {
                kind: 'EVENT',
                updatedAt: { lt: new Date(now.getTime() - retention.eventMaxAgeMs) },
              },
              select: { id: true },
              take,
            }),
          ),
        (ids) =>
          this.all(() => this.prisma.veleroResource.deleteMany({ where: { id: { in: ids } } })),
      );

      report.softDeleted = await this.sweep(
        'soft_deleted',
        async (take) =>
          this.all(() =>
            this.prisma.veleroResource.findMany({
              where: {
                OR: [
                  {
                    kind: { notIn: ['BACKUP', 'RESTORE'] },
                    deletedAt: { lt: new Date(now.getTime() - retention.deletedObjectMaxAgeMs) },
                  },
                  {
                    kind: { in: ['BACKUP', 'RESTORE'] },
                    deletedAt: { lt: new Date(now.getTime() - retention.deletedHistoryMaxAgeMs) },
                  },
                ],
              },
              select: { id: true },
              take,
            }),
          ),
        (ids) =>
          this.all(() => this.prisma.veleroResource.deleteMany({ where: { id: { in: ids } } })),
      );

      report.files = await this.sweep(
        'files',
        async (take) =>
          this.all(() =>
            this.prisma.veleroFile.findMany({
              where: { expiresAt: { lt: now } },
              select: { id: true },
              take,
            }),
          ),
        (ids) => this.all(() => this.prisma.veleroFile.deleteMany({ where: { id: { in: ids } } })),
      );

      report.commands = await this.sweep(
        'commands',
        async (take) =>
          this.all(() =>
            this.prisma.command.findMany({
              where: {
                status: { in: [...TERMINAL] },
                createdAt: { lt: new Date(now.getTime() - retention.commandMaxAgeMs) },
              },
              select: { id: true },
              take,
            }),
          ),
        (ids) => this.all(() => this.prisma.command.deleteMany({ where: { id: { in: ids } } })),
      );

      if (this.env.RETENTION_AUDIT) {
        report.audit = await this.purgeAudit(now);
        report.partial = report.audit.some((a) => a.skipped !== undefined);
      }
      retentionRuns.inc({ status: report.partial ? 'partial' : 'ok' });
    } catch (error) {
      retentionRuns.inc({ status: 'failed' });
      throw error;
    }
    this.logger.log(`retention: ${JSON.stringify({ ...report, audit: report.audit.length })}`);
    return report;
  }

  /** The single place this job reaches across organizations. */
  private all<T>(fn: () => Promise<T>): Promise<T> {
    return this.prisma.unscoped('retention spans every organization', fn);
  }

  private async sweep(
    kind: string,
    find: (take: number) => Promise<{ id: string }[]>,
    remove: (ids: string[]) => Promise<{ count: number }>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await find(BATCH);
      if (rows.length === 0) {
        break;
      }
      const { count } = await remove(rows.map((r) => r.id));
      total += count;
      if (rows.length < BATCH) {
        break;
      }
    }
    if (total > 0) {
      retentionDeleted.inc({ kind }, total);
    }
    return total;
  }

  private async purgeAudit(now: Date): Promise<AuditPurge[]> {
    const out: AuditPurge[] = [];
    const orgs = await this.prisma.organization.findMany({
      select: { id: true, slug: true, settings: true },
    });
    for (const org of orgs) {
      const settings = parseOrgSettings(org.settings);
      const cutoff = new Date(now.getTime() - settings.auditRetentionDays * DAY);
      out.push(await this.purgeOne(org.id, org.slug, cutoff, settings.auditExportBeforeDelete));
    }
    // Events with no organization (a sign-in before one is chosen) follow the default; they cannot be exported per organization.
    out.push(
      await this.purgeOne(
        null,
        'no-organization',
        new Date(now.getTime() - retention.auditDefaultDays * DAY),
        false,
      ),
    );
    return out.filter((o) => o.deleted > 0 || o.skipped !== undefined);
  }

  private async purgeOne(
    orgId: string | null,
    slug: string,
    cutoff: Date,
    exportFirst: boolean,
  ): Promise<AuditPurge> {
    const result: AuditPurge = { orgId, deleted: 0 };
    try {
      if (exportFirst && orgId !== null) {
        const file = await this.exportBefore(orgId, slug, cutoff);
        if (file === undefined) {
          // Never delete what was meant to be kept first.
          result.skipped =
            'export before delete is on but nothing was written (AUDIT_EXPORT_DIR is unset or there was nothing to export)';
          if (!(await this.hasAuditUpTo(orgId, cutoff))) {
            delete result.skipped;
          }
          if (result.skipped !== undefined) {
            this.logger.warn(`audit retention for ${slug}: ${result.skipped}`);
            return result;
          }
        } else {
          result.exportedTo = file;
        }
      }
      result.deleted = await deleteAuditUpTo(this.prisma, orgId, cutoff);
      if (result.deleted > 0) {
        retentionDeleted.inc({ kind: 'audit' }, result.deleted);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'unknown';
      // Typically "permission denied to set role": the application may not delete audit events, by design.
      result.skipped = /role|permission/i.test(text)
        ? 'this database login may not act as vfm_audit_retention (see docs/OPERATIONS.md, audit retention)'
        : `failed: ${text}`;
      this.logger.warn(`audit retention for ${slug}: ${result.skipped}`);
    }
    return result;
  }

  private async hasAuditUpTo(orgId: string, cutoff: Date): Promise<boolean> {
    const n = await this.all(() =>
      this.prisma.auditEvent.count({ where: { orgId, createdAt: { lte: cutoff } } }),
    );
    return n > 0;
  }

  /**
   * Writes every event up to `cutoff` for the organization to a CSV file (the same columns as the
   * UI's export) and returns its path; `undefined` when there is nothing to write or nowhere to write it.
   * The file appears under its final name only once it is complete.
   */
  private async exportBefore(
    orgId: string,
    slug: string,
    cutoff: Date,
  ): Promise<string | undefined> {
    const dir = this.env.AUDIT_EXPORT_DIR;
    if (dir === undefined) {
      return undefined;
    }
    if (!(await this.hasAuditUpTo(orgId, cutoff))) {
      return undefined;
    }
    await mkdir(dir, { recursive: true });
    const name = `audit-${slug.replace(/[^a-z0-9-]/gi, '_')}-up-to-${cutoff.toISOString().slice(0, 10)}-${Date.now().toString()}.csv`;
    const final = join(dir, name);
    const partial = `${final}.partial`;
    const out = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
    try {
      const write = async (text: string): Promise<void> => {
        if (!out.write(text)) {
          await once(out, 'drain');
        }
      };
      await write(csvRow(AUDIT_CSV_HEADER));
      for await (const batch of this.audit.iterate(orgId, { to: cutoff })) {
        for (const event of batch) {
          await write(auditCsvLine(event));
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end((error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await rename(partial, final);
      return final;
    } catch (error) {
      out.destroy();
      await rm(partial, { force: true });
      throw error;
    }
  }
}
