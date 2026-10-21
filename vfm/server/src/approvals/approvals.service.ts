import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Command as CommandRow } from '@prisma/client';

import { CommandsService, type CommandView } from '../commands/commands.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { restoreCoverage } from '../restores/restore-request';

const DECIDED_DAYS = 30;
const LIST_MAX = 100;
const MAX_APPROVERS_SCANNED = 200;
const MAX_MAILS = 20;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : [];
const text = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v.slice(0, 253) : null;

export interface Person {
  id: string;
  email: string;
  name: string | null;
}

export interface ApprovalItem {
  id: string;
  clusterId: string;
  clusterName: string;
  status: CommandRow['status'];
  requestedBy: Person | null;
  createdAt: Date;
  /** When an undecided request times out. */
  expiresAt: Date;
  decidedAt: Date | null;
  approvedBy: Person | null;
  rejectedBy: Person | null;
  decisionNote: string | null;
  /** The caller may decide it now: waiting, not their own, and they may restore here. */
  canApprove: boolean;
  isMine: boolean;
  /** What would be restored: names and options only, never a spec. */
  summary: {
    backupName: string | null;
    scheduleName: string | null;
    namespaces: string[];
    namespaceMapping: Record<string, string>;
    includesClusterResources: boolean;
    existingResourcePolicy: string | null;
    restorePVs: boolean | null;
  };
}

/**
 * Restore approval (PLAN.md §8.4, §16 day 35). A restore on a cluster that requires approval
 * is recorded as `PENDING_APPROVAL` and not sent anywhere. Someone **other than the requester**
 * who may restore the same namespaces on that cluster approves or rejects it; only then is it
 * queued. Both decisions are audited by the request middleware, and the people concerned are
 * told by email when the server can send mail.
 *
 * Nothing here trusts the stored request more than the rules do: the approver is checked
 * against the namespaces the restore will write, and so is the requester again at approval
 * time, because a permission withdrawn since the request must not be spent by someone else's
 * click.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly commands: CommandsService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Requests the caller made, or may decide. `pending` is what is waiting; `decided` is the last 30 days. */
  async list(orgId: string, userId: string, which: 'pending' | 'decided'): Promise<ApprovalItem[]> {
    const since = new Date(Date.now() - DECIDED_DAYS * 86_400_000);
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.findMany({
        where:
          which === 'pending'
            ? { op: 'CREATE_RESTORE', status: 'PENDING_APPROVAL' }
            : {
                op: 'CREATE_RESTORE',
                createdAt: { gte: since },
                // Approved, rejected, withdrawn or expired: each leaves a decision time.
                decidedAt: { not: null },
              },
        orderBy: { createdAt: 'desc' },
        take: LIST_MAX * 3,
      }),
    );
    if (rows.length === 0) return [];

    const clusters = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.clusterId))] } },
        select: { id: true, name: true },
      }),
    );
    const clusterName = new Map(clusters.map((c) => [c.id, c.name]));
    const people = await this.people(orgId, rows);

    const visibility = new Map<string, Awaited<ReturnType<RbacService['visibility']>>>();
    const items: ApprovalItem[] = [];
    for (const row of rows) {
      let v = visibility.get(row.clusterId);
      if (v === undefined) {
        v = await this.rbac.visibility(orgId, userId, row.clusterId, 'restore:create');
        visibility.set(row.clusterId, v);
      }
      const payload = isRecord(row.payload) ? row.payload : {};
      const covered = restoreCoverage({
        includedNamespaces: strings(payload.includedNamespaces),
        namespaceMapping: isRecord(payload.namespaceMapping)
          ? (payload.namespaceMapping as Record<string, string>)
          : {},
        includeClusterResources: payload.includeClusterResources === false ? false : undefined,
      });
      const mine = row.requestedById === userId;
      const mayRestore = v.all || v.sees(covered);
      if (!mine && !mayRestore) continue;
      items.push(
        this.item(row, clusterName, people, payload, covered, {
          isMine: mine,
          canApprove: row.status === 'PENDING_APPROVAL' && !mine && mayRestore,
        }),
      );
      if (items.length === LIST_MAX) break;
    }
    return items;
  }

  /** The number waiting that the caller may decide: for the badge in the navigation. */
  async waitingFor(orgId: string, userId: string): Promise<number> {
    return (await this.list(orgId, userId, 'pending')).filter((i) => i.canApprove).length;
  }

  async approve(orgId: string, userId: string, commandId: string): Promise<CommandView> {
    const row = await this.waiting(orgId, commandId);
    await this.mayDecide(orgId, userId, row);
    // The requester must still be allowed to do what they asked: approval spends their request.
    const stillAllowed = await this.rbac
      .require(orgId, row.requestedById ?? '', this.request(row))
      .then(() => true)
      .catch(() => false);
    if (!stillAllowed) {
      throw new ConflictException(
        'the person who asked no longer has permission to restore this; reject the request instead',
      );
    }
    const done = await this.commands.approve(orgId, row.clusterId, commandId, userId);
    void this.tell(orgId, row, 'approved', userId, null);
    return done;
  }

  async reject(
    orgId: string,
    userId: string,
    commandId: string,
    note: string | null,
  ): Promise<CommandView> {
    const row = await this.waiting(orgId, commandId);
    await this.mayDecide(orgId, userId, row);
    const done = await this.commands.reject(orgId, row.clusterId, commandId, userId, note);
    void this.tell(orgId, row, 'rejected', userId, note);
    return done;
  }

  /** Tells the people who could decide a new request that it is waiting. Never throws. */
  async announceRequest(orgId: string, commandId: string): Promise<void> {
    try {
      if (!this.mail.configured) return;
      const row = await this.prisma.inOrg(orgId, () =>
        this.prisma.command.findFirst({ where: { id: commandId, op: 'CREATE_RESTORE' } }),
      );
      if (row === null || row.status !== 'PENDING_APPROVAL') return;
      const [members, cluster] = await this.prisma.inOrg(orgId, () =>
        Promise.all([
          this.prisma.membership.findMany({
            take: MAX_APPROVERS_SCANNED,
            select: { user: { select: { id: true, email: true } } },
          }),
          this.prisma.cluster.findUnique({ where: { id: row.clusterId }, select: { name: true } }),
        ]),
      );
      const covered = this.request(row);
      const to: string[] = [];
      for (const m of members) {
        if (m.user.id === row.requestedById) continue;
        const v = await this.rbac.visibility(orgId, m.user.id, row.clusterId, 'restore:create');
        if (
          v.all ||
          v.sees({
            namespaces: covered.namespaces,
            includesClusterScoped: covered.includesClusterScoped,
          })
        ) {
          to.push(m.user.email);
        }
        if (to.length >= MAX_MAILS) break;
      }
      const requester = (await this.people(orgId, [row])).get(row.requestedById ?? '');
      const payload = isRecord(row.payload) ? row.payload : {};
      const body = [
        `${requester?.email ?? 'Someone'} asked to restore on cluster ${cluster?.name ?? row.clusterId}.`,
        '',
        `Source:     ${text(payload.backupName) ?? text(payload.scheduleName) ?? 'unknown'}`,
        `Namespaces: ${strings(payload.includedNamespaces).join(', ') || 'all'}`,
        `Expires:    ${row.deadlineAt.toISOString()}`,
        '',
        'Nothing happens until someone else approves it:',
        `${this.env.PUBLIC_URL}/approvals`,
      ].join('\n');
      for (const address of to) {
        await this.mail
          .send({
            to: address,
            subject: `[VFM] Restore waiting for approval on ${cluster?.name ?? 'a cluster'}`,
            text: body,
          })
          .catch(() => undefined);
      }
    } catch (error: unknown) {
      this.logger.warn(
        `could not announce a restore request: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  // ------------------------------------------------------------------

  private request(row: CommandRow) {
    const payload = isRecord(row.payload) ? row.payload : {};
    const covered = restoreCoverage({
      includedNamespaces: strings(payload.includedNamespaces),
      namespaceMapping: isRecord(payload.namespaceMapping)
        ? (payload.namespaceMapping as Record<string, string>)
        : {},
      includeClusterResources: payload.includeClusterResources === false ? false : undefined,
    });
    return {
      clusterId: row.clusterId,
      permission: 'restore:create' as const,
      namespaces: covered.namespaces,
      includesClusterScoped: covered.includesClusterScoped,
    };
  }

  private async waiting(orgId: string, commandId: string): Promise<CommandRow> {
    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.findFirst({ where: { id: commandId, op: 'CREATE_RESTORE' } }),
    );
    if (row === null) throw new NotFoundException('request not found');
    if (row.status !== 'PENDING_APPROVAL') {
      throw new ConflictException('the request is no longer waiting for approval');
    }
    return row;
  }

  private async mayDecide(orgId: string, userId: string, row: CommandRow): Promise<void> {
    if (row.requestedById === userId) {
      throw new ForbiddenException(
        'a restore must be decided by someone other than the person who asked for it',
      );
    }
    // 404 when the caller cannot see the cluster, 403 when they can but may not restore these namespaces.
    await this.rbac.require(orgId, userId, this.request(row));
  }

  private async people(orgId: string, rows: CommandRow[]): Promise<Map<string, Person>> {
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.requestedById, r.approvedById, r.rejectedById])
          .filter((x): x is string => x !== null),
      ),
    ];
    if (ids.length === 0) return new Map();
    const members = await this.prisma.inOrg(orgId, () =>
      this.prisma.membership.findMany({
        where: { userId: { in: ids } },
        select: { user: { select: { id: true, email: true, name: true } } },
      }),
    );
    return new Map(members.map((m) => [m.user.id, m.user]));
  }

  private item(
    row: CommandRow,
    clusterName: Map<string, string>,
    people: Map<string, Person>,
    payload: Record<string, unknown>,
    covered: { namespaces: string[]; includesClusterScoped: boolean },
    flags: { isMine: boolean; canApprove: boolean },
  ): ApprovalItem {
    const person = (id: string | null): Person | null =>
      id === null ? null : (people.get(id) ?? null);
    return {
      id: row.id,
      clusterId: row.clusterId,
      clusterName: clusterName.get(row.clusterId) ?? 'a deleted cluster',
      status: row.status,
      requestedBy: person(row.requestedById),
      createdAt: row.createdAt,
      expiresAt: row.deadlineAt,
      decidedAt: row.decidedAt,
      approvedBy: person(row.approvedById),
      rejectedBy: person(row.rejectedById),
      decisionNote: row.decisionNote,
      ...flags,
      summary: {
        backupName: text(payload.backupName),
        scheduleName: text(payload.scheduleName),
        namespaces: covered.namespaces,
        namespaceMapping: isRecord(payload.namespaceMapping)
          ? (Object.fromEntries(
              Object.entries(payload.namespaceMapping)
                .filter(([, v]) => typeof v === 'string')
                .slice(0, 100),
            ) as Record<string, string>)
          : {},
        includesClusterResources: covered.includesClusterScoped,
        existingResourcePolicy: text(payload.existingResourcePolicy),
        restorePVs: typeof payload.restorePVs === 'boolean' ? payload.restorePVs : null,
      },
    };
  }

  /** Tells the requester how it went. Best effort. */
  private async tell(
    orgId: string,
    row: CommandRow,
    outcome: 'approved' | 'rejected',
    deciderId: string,
    note: string | null,
  ): Promise<void> {
    try {
      if (!this.mail.configured || row.requestedById === null) return;
      const people = await this.people(orgId, [{ ...row, approvedById: deciderId }]);
      const to = people.get(row.requestedById)?.email;
      if (to === undefined) return;
      const decider = people.get(deciderId)?.email ?? 'an approver';
      const payload = isRecord(row.payload) ? row.payload : {};
      await this.mail.send({
        to,
        subject: `[VFM] Your restore was ${outcome}`,
        text: [
          `${decider} ${outcome} your restore of ${text(payload.backupName) ?? text(payload.scheduleName) ?? 'a backup'}.`,
          ...(note === null || note === ''
            ? []
            : ['', `Reason: ${note.replace(/[\r\n]+/g, ' ').slice(0, 500)}`]),
          '',
          `${this.env.PUBLIC_URL}/approvals`,
        ].join('\n'),
      });
    } catch (error: unknown) {
      this.logger.warn(
        `could not tell the requester: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}
