import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Command as CommandRow, Prisma } from '@prisma/client';

import { newId } from '../common/uuid';
import { DownloadAssembler } from '../downloads/download-assembler';
import { DownloadCache } from '../downloads/download-cache.service';
import { DEFAULT_MAX_BYTES, partByKey } from '../downloads/parts';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ErrorCode } from '../gateway/pb/vfm/agent/v1/common';
import { CommandAckState } from '../gateway/pb/vfm/agent/v1/command';
import { ServerMessage, type AgentMessage } from '../gateway/pb/vfm/agent/v1/gateway';
import { StreamsService } from '../streams/streams.service';
import { clean, sanitizeVeleroStatus } from '../streams/hello';
import {
  commandDuration,
  commandsTotal,
  commandsUnfinished,
  onSampleUnfinished,
} from '../metrics/metrics';
import { withSpan } from '../metrics/tracing';
import { NON_TERMINAL, statusesAccepting, TERMINAL } from './command-state';
import { isOp, OPS, TransientUnavailableError, type OpKey, type Transient } from './ops';

/** A cluster with this many unfinished commands refuses more: a stuck agent must not grow the table without bound. */
const MAX_UNFINISHED_PER_CLUSTER = 100;
const TIMEOUT_SWEEP_EVERY_MS = 10_000;
const TIMEOUT_LOCK_KEY = 'vfm:commands:sweeper';
const TIMEOUT_LOCK_TTL_S = 8;
const LIST_LIMIT = 50;
const MAX_PENDING_APPROVALS_PER_CLUSTER = 25;
const MAX_ERROR_TEXT = 1_000;

export interface CommandView {
  id: string;
  clusterId: string;
  op: string;
  status: CommandRow['status'];
  errorCode: string | null;
  errorMessage: string | null;
  result: unknown;
  attempts: number;
  deadlineAt: Date;
  createdAt: Date;
  finishedAt: Date | null;
}

const view = (c: CommandRow): CommandView => ({
  id: c.id,
  clusterId: c.clusterId,
  op: c.op,
  status: c.status,
  errorCode: c.errorCode,
  errorMessage: c.errorMessage,
  result: c.result,
  attempts: c.attempts,
  deadlineAt: c.deadlineAt,
  createdAt: c.createdAt,
  finishedAt: c.finishedAt,
});

const text = (value: string): string => clean(value, MAX_ERROR_TEXT);

/**
 * The command pipeline (PLAN.md §5.4, §16 day 14): queue, route, send,
 * acknowledge, finish, time out, cancel, and re-deliver after a reconnect.
 *
 * The database row is the source of truth. A command is written `QUEUED`
 * **before** anything is sent, so a crash between the two loses nothing; sending
 * is then an optimisation that happens straight away when the agent is
 * connected and otherwise waits for the agent's next Hello.
 *
 * The agent is semi-trusted. It can only report on commands of **its own
 * cluster**, and it can only move them forward through the state machine.
 */
@Injectable()
export class CommandsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CommandsService.name);
  private timer: NodeJS.Timeout | undefined;
  private readonly assembler = new DownloadAssembler();
  /**
   * Secret material for commands in flight, by command id. Memory only, so it is in no
   * dump, backup or log; it lives until the command ends or its deadline passes.
   */
  private readonly transients = new Map<string, { value: Transient; expires: number }>();

  /** Tunable at runtime so a test can turn the on-connect refresh on for one case. */
  readonly options: { refreshOnConnect: boolean };
  /** How long a request waits for approval; tests shorten it. */
  approvalTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly streams: StreamsService,
    private readonly events: EventsService,
    private readonly cache: DownloadCache,
    @Inject(ENV) env: Env,
  ) {
    this.options = { refreshOnConnect: env.COMMANDS_REFRESH_ON_CONNECT };
    this.approvalTtlMs = env.RESTORE_APPROVAL_TTL_HOURS * 3_600_000;
    onSampleUnfinished(() => this.sampleUnfinished());
  }

  /** The op and start time of commands seen in flight, so a final status can be timed without a lookup each time. */
  private readonly inFlight = new Map<string, { op: string; createdAt: Date }>();
  private unfinishedAt = 0;

  /** Feeds the work-queue gauge; read from the database at most every 5 s, however often Prometheus scrapes. */
  private async sampleUnfinished(): Promise<void> {
    if (Date.now() - this.unfinishedAt < 5_000) return;
    this.unfinishedAt = Date.now();
    const rows = await this.prisma.unscoped('the unfinished-commands gauge spans every org', () =>
      this.prisma.command.groupBy({
        by: ['status'],
        where: { status: { in: [...NON_TERMINAL, 'PENDING_APPROVAL'] } },
        _count: { _all: true },
      }),
    );
    commandsUnfinished.reset();
    for (const status of [...NON_TERMINAL, 'PENDING_APPROVAL']) {
      commandsUnfinished.set({ status }, rows.find((r) => r.status === status)?._count._all ?? 0);
    }
  }

  /** Counts a transition and, at a final status, times the command. A failure here must never fail the command. */
  private async observe(orgId: string, commandId: string, status: string): Promise<void> {
    try {
      let known = this.inFlight.get(commandId);
      if (known === undefined) {
        const row = await this.prisma.inOrg(orgId, () =>
          this.prisma.command.findUnique({
            where: { id: commandId },
            select: { op: true, createdAt: true },
          }),
        );
        if (row === null) return;
        known = { op: row.op, createdAt: row.createdAt };
        if (this.inFlight.size > 5_000) this.inFlight.clear();
        this.inFlight.set(commandId, known);
      }
      commandsTotal.inc({ op: known.op, status });
      if (TERMINAL.has(status as CommandRow['status'])) {
        commandDuration.observe(
          { op: known.op, status },
          (Date.now() - known.createdAt.getTime()) / 1000,
        );
        this.inFlight.delete(commandId);
      }
    } catch {
      // Metrics are best effort.
    }
  }

  onApplicationBootstrap(): void {
    this.streams.onAgentMessage((clusterId, message) => this.onAgentMessage(clusterId, message));
    this.streams.onConnected((clusterId, orgId) => this.redeliver(orgId, clusterId));

    this.timer = setInterval(() => {
      this.sweepTimeouts().catch((error: unknown) => {
        this.logger.warn(
          `command timeout sweep failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
    }, TIMEOUT_SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Records the command and sends it now if the agent is connected. */
  async enqueue(
    orgId: string,
    clusterId: string,
    requestedById: string | null,
    op: OpKey,
    payload: Record<string, unknown> = {},
    transient?: Transient,
    options: { pendingApproval?: boolean } = {},
  ): Promise<CommandView> {
    const cluster = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findUnique({ where: { id: clusterId }, select: { status: true } }),
    );
    if (cluster === null) {
      throw new NotFoundException('cluster not found');
    }
    if (cluster.status === 'DISABLED') {
      throw new ConflictException('the cluster is disabled');
    }

    const unfinished = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.count({ where: { clusterId, status: { in: [...NON_TERMINAL] } } }),
    );
    if (unfinished >= MAX_UNFINISHED_PER_CLUSTER) {
      throw new HttpException(
        'this cluster has too many unfinished commands; is its agent connected?',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const pending = options.pendingApproval === true;
    if (pending) {
      // Requests waiting for a person are bounded too, or one user could pile them up.
      const waiting = await this.prisma.inOrg(orgId, () =>
        this.prisma.command.count({ where: { clusterId, status: 'PENDING_APPROVAL' } }),
      );
      if (waiting >= MAX_PENDING_APPROVALS_PER_CLUSTER) {
        throw new HttpException(
          'this cluster already has many restores waiting for approval; decide or withdraw some first',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.create({
        data: {
          id: newId(),
          orgId,
          clusterId,
          requestedById,
          op,
          payload: payload as Prisma.InputJsonValue,
          status: pending ? 'PENDING_APPROVAL' : 'QUEUED',
          // A request waiting for approval has until the approval window closes; the agent's
          // own deadline starts when it is approved.
          deadlineAt: new Date(Date.now() + (pending ? this.approvalTtlMs : OPS[op].timeoutMs)),
        },
      }),
    );

    if (transient !== undefined) {
      this.transients.set(row.id, { value: transient, expires: row.deadlineAt.getTime() });
    }

    // Best effort: an undelivered command stays QUEUED and goes out on connect. A request
    // waiting for approval is not sent: the agent does not hear of it until it is approved.
    if (!pending) {
      await this.deliver(row).catch((error: unknown) => {
        this.logger.warn(
          `could not send command ${row.id}: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
    }
    const created = view(await this.find(orgId, clusterId, row.id));
    await this.announce(orgId, clusterId, created.id, created.status);
    return created;
  }

  /** Tells subscribed browsers a command moved; they re-read it through the REST API. */
  private async announce(
    orgId: string,
    clusterId: string,
    commandId: string,
    status: string,
  ): Promise<void> {
    await this.observe(orgId, commandId, status);
    return this.events.publish({ type: 'command', orgId, clusterId, commandId, status });
  }

  async get(orgId: string, clusterId: string, commandId: string): Promise<CommandView> {
    return view(await this.find(orgId, clusterId, commandId));
  }

  async list(orgId: string, clusterId: string): Promise<CommandView[]> {
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.findMany({
        where: { clusterId },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
    );
    return rows.map(view);
  }

  /**
   * Releases a request that was waiting for approval: it becomes an ordinary queued command
   * and is sent at once if the agent is connected. The approver must not be the requester,
   * and the check is part of the same conditional `UPDATE` that changes the status, so two
   * decisions at once cannot both win and a requester cannot approve their own request.
   */
  async approve(
    orgId: string,
    clusterId: string,
    commandId: string,
    approverId: string,
  ): Promise<CommandView> {
    const row = await this.find(orgId, clusterId, commandId);
    if (row.requestedById === approverId) {
      throw new ForbiddenException(
        'a restore must be approved by someone other than the person who asked for it',
      );
    }
    const now = new Date();
    const result = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.updateMany({
        where: {
          id: commandId,
          status: 'PENDING_APPROVAL',
          deadlineAt: { gt: now },
          NOT: { requestedById: approverId },
        },
        data: {
          status: 'QUEUED',
          approvedById: approverId,
          decidedAt: now,
          deadlineAt: new Date(now.getTime() + OPS[row.op as OpKey].timeoutMs),
        },
      }),
    );
    if (result.count === 0) {
      throw new ConflictException('the request is no longer waiting for approval');
    }
    const released = await this.find(orgId, clusterId, commandId);
    await this.deliver(released).catch((error: unknown) => {
      this.logger.warn(
        `could not send command ${commandId}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
    const done = view(await this.find(orgId, clusterId, commandId));
    await this.announce(orgId, clusterId, commandId, done.status);
    return done;
  }

  /** Turns a waiting request down. The agent never hears of it. */
  async reject(
    orgId: string,
    clusterId: string,
    commandId: string,
    rejecterId: string,
    note: string | null,
  ): Promise<CommandView> {
    const row = await this.find(orgId, clusterId, commandId);
    if (row.requestedById === rejecterId) {
      throw new ForbiddenException('withdraw your own request instead of rejecting it');
    }
    const now = new Date();
    const result = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.updateMany({
        where: { id: commandId, status: 'PENDING_APPROVAL', NOT: { requestedById: rejecterId } },
        data: {
          status: 'REJECTED',
          rejectedById: rejecterId,
          decidedAt: now,
          finishedAt: now,
          decisionNote: note === null ? null : text(note).slice(0, 500),
          errorCode: 'REJECTED',
          errorMessage: 'the restore was not approved',
        },
      }),
    );
    if (result.count === 0) {
      throw new ConflictException('the request is no longer waiting for approval');
    }
    await this.announce(orgId, clusterId, commandId, 'REJECTED');
    return view(await this.find(orgId, clusterId, commandId));
  }

  /** Cancels a command the agent has not yet taken (PLAN.md §5.4). */
  async cancel(
    orgId: string,
    clusterId: string,
    commandId: string,
    userId?: string,
  ): Promise<CommandView> {
    const row = await this.find(orgId, clusterId, commandId);
    if (row.status === 'PENDING_APPROVAL') {
      // Withdrawing a request is the requester's to do; anyone else who can read the cluster
      // must not be able to quietly cancel someone's restore.
      if (userId === undefined || row.requestedById !== userId) {
        throw new ForbiddenException(
          'only the person who asked can withdraw a restore that is waiting for approval',
        );
      }
      const done = await this.prisma.inOrg(orgId, () =>
        this.prisma.command.updateMany({
          where: { id: commandId, status: 'PENDING_APPROVAL' },
          data: { status: 'CANCELLED', finishedAt: new Date(), decidedAt: new Date() },
        }),
      );
      if (done.count === 0) {
        throw new ConflictException('the request has already been decided');
      }
      await this.announce(orgId, clusterId, commandId, 'CANCELLED');
      return view(await this.find(orgId, clusterId, commandId));
    }
    const result = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.updateMany({
        where: { id: commandId, status: { in: statusesAccepting('cancelled') } },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      }),
    );
    if (result.count === 0) {
      throw new ConflictException(
        row.status === 'ACKED' || row.status === 'RUNNING'
          ? 'the agent has already started this command'
          : 'the command has already finished',
      );
    }
    this.transients.delete(commandId);
    // The agent may have received it already; tell it to drop it if it can.
    await this.streams
      .send(
        row.clusterId,
        ServerMessage.fromPartial({ messageId: randomUUID(), cancel: { commandId } }),
      )
      .catch(() => false);
    await this.announce(orgId, clusterId, commandId, 'CANCELLED');
    return view(await this.find(orgId, clusterId, commandId));
  }

  /** Sends every unfinished command of a cluster, oldest first: the agent has just (re)connected. */
  async redeliver(orgId: string, clusterId: string): Promise<void> {
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.findMany({
        where: { clusterId, status: { in: [...NON_TERMINAL] }, deadlineAt: { gt: new Date() } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    for (const row of rows) {
      await this.deliver(row);
    }
    if (rows.length > 0) {
      this.logger.log(`re-delivered ${rows.length.toString()} command(s) to cluster ${clusterId}`);
    }

    if (this.options.refreshOnConnect && !rows.some((row) => row.op === 'REFRESH_STATUS')) {
      // Not on behalf of a user: the control plane is keeping its own record fresh.
      await this.enqueue(orgId, clusterId, null, 'REFRESH_STATUS');
    }
  }

  /** Marks commands past their deadline `TIMED_OUT`, and asks their agents to stop them. */
  async sweepTimeouts(): Promise<number> {
    this.assembler.expire();
    const now0 = Date.now();
    for (const [id, held] of this.transients) {
      if (held.expires < now0) {
        this.transients.delete(id);
      }
    }
    const lock = await this.redis.connection.set(
      TIMEOUT_LOCK_KEY,
      '1',
      'EX',
      TIMEOUT_LOCK_TTL_S,
      'NX',
    );
    if (lock === null) {
      return 0;
    }
    const now = new Date();
    const overdue = await this.prisma.unscoped('the command timeout sweeper spans every org', () =>
      this.prisma.command.findMany({
        where: { status: { in: [...NON_TERMINAL] }, deadlineAt: { lt: now } },
        select: { id: true, orgId: true, clusterId: true, status: true },
      }),
    );

    let expired = 0;
    // Requests nobody decided in time: nothing was ever sent, so there is no agent to tell.
    const unanswered = await this.prisma.unscoped(
      'the command timeout sweeper spans every org',
      () =>
        this.prisma.command.findMany({
          where: { status: 'PENDING_APPROVAL', deadlineAt: { lt: now } },
          select: { id: true, orgId: true, clusterId: true },
        }),
    );
    for (const command of unanswered) {
      const result = await this.prisma.inOrg(command.orgId, () =>
        this.prisma.command.updateMany({
          where: { id: command.id, status: 'PENDING_APPROVAL' },
          data: {
            status: 'TIMED_OUT',
            finishedAt: now,
            decidedAt: now,
            errorCode: 'APPROVAL_EXPIRED',
            errorMessage: 'nobody approved the restore in time',
          },
        }),
      );
      expired += result.count;
      if (result.count > 0) {
        await this.announce(command.orgId, command.clusterId, command.id, 'TIMED_OUT');
      }
    }
    for (const command of overdue) {
      const result = await this.prisma.inOrg(command.orgId, () =>
        this.prisma.command.updateMany({
          where: { id: command.id, status: { in: [...NON_TERMINAL] } },
          data: {
            status: 'TIMED_OUT',
            finishedAt: now,
            errorCode: 'TIMEOUT',
            errorMessage: 'the command did not finish before its deadline',
          },
        }),
      );
      expired += result.count;
      if (result.count > 0) {
        await this.announce(command.orgId, command.clusterId, command.id, 'TIMED_OUT');
      }
      if (result.count > 0 && command.status !== 'QUEUED') {
        await this.streams
          .send(
            command.clusterId,
            ServerMessage.fromPartial({
              messageId: randomUUID(),
              cancel: { commandId: command.id },
            }),
          )
          .catch(() => false);
      }
    }
    return expired;
  }

  /** Writes the command to the agent's stream and records that it was sent. */
  private async deliver(row: CommandRow): Promise<boolean> {
    if (!isOp(row.op)) {
      await this.fail(row, 'INTERNAL', `unknown operation ${row.op}`);
      return false;
    }
    let built;
    try {
      built = OPS[row.op].build(
        (row.payload ?? {}) as Record<string, unknown>,
        this.transients.get(row.id)?.value,
      );
    } catch (error) {
      if (error instanceof TransientUnavailableError) {
        await this.fail(row, 'INVALID_ARGUMENT', error.message);
        await this.announce(row.orgId, row.clusterId, row.id, 'FAILED');
        return false;
      }
      throw error;
    }
    const message = ServerMessage.fromPartial({
      messageId: randomUUID(),
      command: {
        commandId: row.id,
        deadline: row.deadlineAt,
        requestedBy: row.requestedById ?? '',
        ...built,
      },
    });

    const sent = await withSpan(
      'command.deliver',
      { 'vfm.cluster_id': row.clusterId, 'vfm.command_id': row.id, 'vfm.op': row.op },
      () => this.streams.send(row.clusterId, message),
    );
    if (!sent) {
      return false;
    }
    await this.prisma.inOrg(row.orgId, async () => {
      await this.prisma.command.updateMany({
        where: { id: row.id, status: { in: [...NON_TERMINAL] } },
        data: { attempts: { increment: 1 } },
      });
      // Only QUEUED moves to SENT: a command already acknowledged is not regressed.
      await this.prisma.command.updateMany({
        where: { id: row.id, status: 'QUEUED' },
        data: { status: 'SENT', sentAt: new Date() },
      });
    });
    return true;
  }

  private async fail(row: CommandRow, code: string, message: string): Promise<void> {
    this.transients.delete(row.id);
    await this.prisma.inOrg(row.orgId, () =>
      this.prisma.command.updateMany({
        where: { id: row.id, status: { in: [...NON_TERMINAL] } },
        data: { status: 'FAILED', errorCode: code, errorMessage: message, finishedAt: new Date() },
      }),
    );
  }

  private async find(orgId: string, clusterId: string, commandId: string): Promise<CommandRow> {
    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.findFirst({ where: { id: commandId, clusterId } }),
    );
    if (row === null) {
      throw new NotFoundException('command not found');
    }
    return row;
  }

  /** Handles an agent's acknowledgement or result. Anything else is not ours. */
  private async onAgentMessage(clusterId: string, message: AgentMessage): Promise<void> {
    if (message.ack !== undefined) {
      await this.onAck(clusterId, message.ack.commandId, message.ack.state);
    } else if (message.result !== undefined) {
      await this.onResult(clusterId, message.result);
    } else if (message.logChunk !== undefined) {
      await this.onChunk(clusterId, message.logChunk);
    }
  }

  /**
   * Looks a command up on behalf of an agent. It must belong to **that agent's
   * cluster**: a compromised agent that guesses or learns another cluster's
   * command id gets nothing, and the attempt is logged.
   */
  private async ownedCommand(clusterId: string, commandId: string): Promise<CommandRow | null> {
    const row = await this.prisma.unscoped('an agent reports on commands by id', () =>
      this.prisma.command.findUnique({ where: { id: commandId } }),
    );
    if (row === null) {
      return null;
    }
    if (row.clusterId !== clusterId) {
      this.logger.warn(
        `cluster ${clusterId} reported on a command that belongs to another cluster`,
      );
      return null;
    }
    return row;
  }

  private async onAck(clusterId: string, commandId: string, state: CommandAckState): Promise<void> {
    const row = await this.ownedCommand(clusterId, commandId);
    if (row === null) {
      return;
    }
    const now = new Date();
    let moved = 0;
    await this.prisma.inOrg(row.orgId, async () => {
      if (state === CommandAckState.COMMAND_ACK_STATE_RUNNING) {
        moved = (
          await this.prisma.command.updateMany({
            where: { id: commandId, status: { in: statusesAccepting('running') } },
            data: { status: 'RUNNING', startedAt: now },
          })
        ).count;
        // An ack that never arrived is still an ack: record it once.
        await this.prisma.command.updateMany({
          where: { id: commandId, ackedAt: null },
          data: { ackedAt: now },
        });
      } else {
        moved = (
          await this.prisma.command.updateMany({
            where: { id: commandId, status: { in: ['QUEUED', 'SENT'] } },
            data: { status: 'ACKED', ackedAt: now },
          })
        ).count;
      }
    });
    if (moved > 0) {
      await this.announce(
        row.orgId,
        row.clusterId,
        commandId,
        state === CommandAckState.COMMAND_ACK_STATE_RUNNING ? 'RUNNING' : 'ACKED',
      );
    }
  }

  private async onResult(
    clusterId: string,
    result: NonNullable<AgentMessage['result']>,
  ): Promise<void> {
    const row = await this.ownedCommand(clusterId, result.commandId);
    if (row === null) {
      return;
    }
    this.transients.delete(row.id);

    // A download is judged before anything else: the file must be whole and match
    // its checksum, or the command fails whatever the agent says.
    const download = result.ok ? await this.finishDownload(row, result) : undefined;
    if (!result.ok) {
      this.assembler.drop(row.id);
    }
    const ok = result.ok && download?.error === undefined;

    const code = ErrorCode[result.errorCode] as string | undefined;
    const errorCode = ok
      ? null
      : result.ok
        ? 'INTERNAL'
        : (code ?? 'INTERNAL').replace(/^ERROR_CODE_/, '');
    const status = ok ? 'SUCCEEDED' : 'FAILED';
    const errorMessage = ok ? null : (download?.error ?? text(result.errorMessage));

    let detail: Prisma.InputJsonValue | undefined;
    if (ok && download?.detail !== undefined) {
      detail = download.detail;
    } else if (result.ok && result.serverStatus !== undefined) {
      detail = sanitizeVeleroStatus(result.serverStatus);
    } else if (result.ok && result.namespaces !== undefined) {
      detail = {
        namespaces: result.namespaces.namespaces.slice(0, 100).map((n) => ({
          name: text(n.name).slice(0, 63),
          exists: n.exists,
          terminating: n.terminating,
        })),
      };
    } else if (result.ok && result.created !== undefined) {
      detail = {
        kind: text(result.created.kind).slice(0, 64),
        name: text(result.created.name).slice(0, 253),
        uid: text(result.created.uid).slice(0, 64),
      };
    }

    const updated = await this.prisma.inOrg(row.orgId, () =>
      this.prisma.command.updateMany({
        where: {
          id: row.id,
          status: { in: statusesAccepting(ok ? 'succeeded' : 'failed') },
        },
        data: {
          status,
          errorCode,
          errorMessage,
          ...(detail === undefined ? {} : { result: detail }),
          finishedAt: new Date(),
        },
      }),
    );

    if (updated.count > 0) {
      await this.announce(row.orgId, row.clusterId, row.id, status);
    }

    // Only a result that actually finished the command may change cluster facts:
    // a late duplicate for an already-timed-out command must not.
    if (updated.count > 0 && result.ok && result.serverStatus !== undefined) {
      const velero = sanitizeVeleroStatus(result.serverStatus);
      await this.prisma.inOrg(row.orgId, () =>
        this.prisma.cluster.update({
          where: { id: row.clusterId },
          data: { veleroVersion: velero.serverVersion, veleroPlugins: velero.plugins },
        }),
      );
    }
  }

  /**
   * Handles one chunk of a download. The first chunk of a command is where its
   * ownership and state are checked (the agent may only send for its own cluster's
   * running downloads); later chunks are held to that decision.
   */
  private async onChunk(
    clusterId: string,
    chunk: NonNullable<AgentMessage['logChunk']>,
  ): Promise<void> {
    const commandId = chunk.commandId;
    if (commandId === undefined) {
      return; // a log session chunk: not ours
    }
    if (chunk.sequence === 0) {
      const row = await this.ownedCommand(clusterId, commandId);
      if (
        row === null ||
        row.op !== 'FETCH_DOWNLOAD' ||
        !['SENT', 'ACKED', 'RUNNING'].includes(row.status)
      ) {
        return;
      }
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const limit = typeof payload.maxBytes === 'number' ? payload.maxBytes : DEFAULT_MAX_BYTES;
      const refused = this.assembler.start(commandId, clusterId, limit);
      if (refused !== undefined) {
        this.logger.warn(`download of command ${commandId} refused: ${refused}`);
        return;
      }
    }
    if (this.assembler.has(commandId)) {
      this.assembler.add(commandId, chunk);
    }
  }

  /** Verifies and stores a finished download. `error` set means the command must fail. */
  private async finishDownload(
    row: CommandRow,
    result: NonNullable<AgentMessage['result']>,
  ): Promise<{ error?: string; detail?: Prisma.InputJsonValue } | undefined> {
    if (row.op !== 'FETCH_DOWNLOAD') {
      return undefined;
    }
    if (result.download === undefined) {
      this.assembler.drop(row.id);
      return { error: 'the agent finished without describing what it sent' };
    }
    const finished = this.assembler.finish(row.id, result.download);
    if (!finished.ok) {
      this.logger.warn(`download of command ${row.id} rejected: ${finished.reason}`);
      return { error: text(`the file did not arrive intact: ${finished.reason}`) };
    }
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const part = partByKey(String(payload.part));
    if (part === undefined) {
      return { error: 'unknown download part' };
    }
    try {
      await this.cache.put(
        {
          orgId: row.orgId,
          clusterId: row.clusterId,
          part: part.key,
          targetName: String(payload.targetName),
          targetUid: String(payload.targetUid),
        },
        finished.data,
        result.download.sha256Hex.toLowerCase(),
        row.id,
        this.cache.retentionSeconds(payload.finished === true),
      );
    } catch (error) {
      this.logger.error(
        `could not store the file of command ${row.id}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return { error: 'the control plane could not store the file' };
    }
    return {
      detail: {
        part: part.key,
        bytes: finished.data.length,
        sha256: result.download.sha256Hex.toLowerCase(),
      },
    };
  }
}
