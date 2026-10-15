import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { AuditActorType, AuditOutcome, Prisma } from '@prisma/client';

import { redact } from '../common/redact';
import { newId } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditInput {
  orgId?: string | null | undefined;
  actorType: AuditActorType;
  actorId?: string | null | undefined;
  action: string;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  clusterId?: string | null | undefined;
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
  requestId?: string | null | undefined;
  outcome: AuditOutcome;
  details?: Record<string, unknown> | undefined;
}

export interface AuditFilter {
  actorId?: string | undefined;
  action?: string | undefined;
  clusterId?: string | undefined;
  outcome?: AuditOutcome | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface AuditEventView {
  id: string;
  orgId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  clusterId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  outcome: AuditOutcome;
  details: unknown;
  createdAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clip = (value: string | null | undefined, max: number): string | null =>
  value === null || value === undefined || value === '' ? null : value.slice(0, max);

const asUuid = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && UUID.test(value) ? value : null;

/**
 * Writes and reads the audit log (PLAN.md §8.4, principle P5).
 *
 * ## Delivery
 *
 * Events for API calls are written **after** the response, from a middleware,
 * so a database failure here cannot turn a successful action into an error.
 * The price is that the audit row is not in the action's transaction: if the
 * insert fails the action stands and the failure is logged at error level.
 * Command audit (M2) is written in the same transaction as the command, as
 * §6 requires; this path is for control-plane mutations.
 */
@Injectable()
export class AuditService implements OnApplicationShutdown {
  private readonly logger = new Logger(AuditService.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly prisma: PrismaService) {}

  /** Records an event without making the caller wait or fail. */
  record(input: AuditInput): void {
    const task = this.write(input)
      .catch((error: unknown) => {
        // Never the event itself: it may name a target the log should not repeat.
        this.logger.error(
          { err: redact(error), action: input.action, outcome: input.outcome },
          'failed to write an audit event',
        );
      })
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  /** Resolves when every event recorded so far has been written. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }

  private async write(input: AuditInput): Promise<void> {
    const details = redact(input.details ?? {}) as Prisma.InputJsonValue;
    await this.prisma.unscoped('audit events may precede org selection and outlive the org', () =>
      this.prisma.auditEvent.create({
        data: {
          id: newId(),
          orgId: asUuid(input.orgId),
          actorType: input.actorType,
          actorId: asUuid(input.actorId),
          action: input.action.slice(0, 200),
          targetType: clip(input.targetType, 100),
          targetId: clip(input.targetId, 200),
          clusterId: asUuid(input.clusterId),
          ip: clip(input.ip, 64),
          userAgent: clip(input.userAgent, 512),
          requestId: clip(input.requestId, 128),
          outcome: input.outcome,
          details,
        },
      }),
    );
  }

  /** Newest first; `cursor` is the last id of the previous page. */
  async list(
    orgId: string,
    filter: AuditFilter,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<{ events: AuditEventView[]; nextCursor: string | null }> {
    const rows = await this.query(orgId, filter, options.limit + 1, options.cursor);
    const page = rows.slice(0, options.limit);
    return {
      events: page,
      nextCursor: rows.length > options.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Streams every matching event in batches, newest first. */
  async *iterate(
    orgId: string,
    filter: AuditFilter,
    batch = 500,
  ): AsyncGenerator<AuditEventView[]> {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.query(orgId, filter, batch, cursor);
      if (rows.length === 0) {
        return;
      }
      yield rows;
      cursor = rows[rows.length - 1]?.id;
      if (rows.length < batch) {
        return;
      }
    }
  }

  private async query(
    orgId: string,
    filter: AuditFilter,
    take: number,
    cursor: string | undefined,
  ): Promise<AuditEventView[]> {
    const where: Prisma.AuditEventWhereInput = {
      ...(filter.actorId === undefined ? {} : { actorId: filter.actorId }),
      ...(filter.clusterId === undefined ? {} : { clusterId: filter.clusterId }),
      ...(filter.outcome === undefined ? {} : { outcome: filter.outcome }),
      ...(filter.action === undefined ? {} : { action: { contains: filter.action } }),
      ...(filter.from === undefined && filter.to === undefined
        ? {}
        : {
            createdAt: {
              ...(filter.from === undefined ? {} : { gte: filter.from }),
              ...(filter.to === undefined ? {} : { lte: filter.to }),
            },
          }),
      ...(cursor === undefined ? {} : { id: { lt: cursor } }),
    };

    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.auditEvent.findMany({ where, orderBy: { id: 'desc' }, take }),
    );

    // Actor emails are looked up, not stored: an address change or an erasure
    // request then takes effect in the log view without rewriting history.
    const actorIds = [...new Set(rows.flatMap((r) => (r.actorId === null ? [] : [r.actorId])))];
    const users =
      actorIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, email: true },
          });
    const emails = new Map(users.map((u) => [u.id, u.email]));

    return rows.map((r) => ({
      ...r,
      actorEmail: r.actorId === null ? null : (emails.get(r.actorId) ?? null),
    }));
  }
}
