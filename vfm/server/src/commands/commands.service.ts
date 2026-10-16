import { randomUUID } from 'node:crypto';

import {
  ConflictException,
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
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ErrorCode } from '../gateway/pb/vfm/agent/v1/common';
import { CommandAckState } from '../gateway/pb/vfm/agent/v1/command';
import { ServerMessage, type AgentMessage } from '../gateway/pb/vfm/agent/v1/gateway';
import { StreamsService } from '../streams/streams.service';
import { clean, sanitizeVeleroStatus } from '../streams/hello';
import { NON_TERMINAL, statusesAccepting } from './command-state';
import { isOp, OPS, type OpKey } from './ops';

/** A cluster with this many unfinished commands refuses more: a stuck agent must not grow the table without bound. */
const MAX_UNFINISHED_PER_CLUSTER = 100;
const TIMEOUT_SWEEP_EVERY_MS = 10_000;
const TIMEOUT_LOCK_KEY = 'vfm:commands:sweeper';
const TIMEOUT_LOCK_TTL_S = 8;
const LIST_LIMIT = 50;
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

  /** Tunable at runtime so a test can turn the on-connect refresh on for one case. */
  readonly options: { refreshOnConnect: boolean };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly streams: StreamsService,
    @Inject(ENV) env: Env,
  ) {
    this.options = { refreshOnConnect: env.COMMANDS_REFRESH_ON_CONNECT };
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

    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.create({
        data: {
          id: newId(),
          orgId,
          clusterId,
          requestedById,
          op,
          payload: payload as Prisma.InputJsonValue,
          deadlineAt: new Date(Date.now() + OPS[op].timeoutMs),
        },
      }),
    );

    // Best effort: an undelivered command stays QUEUED and goes out on connect.
    await this.deliver(row).catch((error: unknown) => {
      this.logger.warn(
        `could not send command ${row.id}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
    return view(await this.find(orgId, clusterId, row.id));
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

  /** Cancels a command the agent has not yet taken (PLAN.md §5.4). */
  async cancel(orgId: string, clusterId: string, commandId: string): Promise<CommandView> {
    const row = await this.find(orgId, clusterId, commandId);
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
    // The agent may have received it already; tell it to drop it if it can.
    await this.streams
      .send(
        row.clusterId,
        ServerMessage.fromPartial({ messageId: randomUUID(), cancel: { commandId } }),
      )
      .catch(() => false);
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
    const message = ServerMessage.fromPartial({
      messageId: randomUUID(),
      command: {
        commandId: row.id,
        deadline: row.deadlineAt,
        requestedBy: row.requestedById ?? '',
        ...OPS[row.op].build((row.payload ?? {}) as Record<string, unknown>),
      },
    });

    if (!(await this.streams.send(row.clusterId, message))) {
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
    await this.prisma.inOrg(row.orgId, async () => {
      if (state === CommandAckState.COMMAND_ACK_STATE_RUNNING) {
        await this.prisma.command.updateMany({
          where: { id: commandId, status: { in: statusesAccepting('running') } },
          data: { status: 'RUNNING', startedAt: now },
        });
        // An ack that never arrived is still an ack: record it once.
        await this.prisma.command.updateMany({
          where: { id: commandId, ackedAt: null },
          data: { ackedAt: now },
        });
      } else {
        await this.prisma.command.updateMany({
          where: { id: commandId, status: { in: ['QUEUED', 'SENT'] } },
          data: { status: 'ACKED', ackedAt: now },
        });
      }
    });
  }

  private async onResult(
    clusterId: string,
    result: NonNullable<AgentMessage['result']>,
  ): Promise<void> {
    const row = await this.ownedCommand(clusterId, result.commandId);
    if (row === null) {
      return;
    }

    const code = ErrorCode[result.errorCode] as string | undefined;
    const errorCode = result.ok ? null : (code ?? 'INTERNAL').replace(/^ERROR_CODE_/, '');
    const status = result.ok ? 'SUCCEEDED' : 'FAILED';

    let detail: Prisma.InputJsonValue | undefined;
    if (result.ok && result.serverStatus !== undefined) {
      detail = sanitizeVeleroStatus(result.serverStatus);
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
          status: { in: statusesAccepting(result.ok ? 'succeeded' : 'failed') },
        },
        data: {
          status,
          errorCode,
          errorMessage: result.ok ? null : text(result.errorMessage),
          ...(detail === undefined ? {} : { result: detail }),
          finishedAt: new Date(),
        },
      }),
    );

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
}
