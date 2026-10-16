import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { CommandsService, type CommandView } from '../commands/commands.service';
import { parseBody } from '../common/parse-body';
import { createCoverage } from '../backups/backup-request';
import { coveredBy } from '../inventory/projections';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService, type TokenLimit } from '../rbac/rbac.service';
import {
  checkSchedule,
  createScheduleBody,
  pauseBody,
  templateCoverage,
  updateScheduleBody,
  type UpdateScheduleBody,
} from './schedule-request';

const MAX_ADVANCED_BYTES = 256 * 1024;

/**
 * Schedule operations: create, update, pause and resume, delete (PLAN.md §6, §16 day 25).
 *
 * A schedule makes backups on its own, later, as the Velero service account, so whoever
 * writes one must be allowed to back up everything its template covers — by the same rule
 * as a backup made by hand (`createCoverage`: a user limited to namespaces names them all
 * and turns cluster resources off). Changing a schedule that already exists also needs the
 * old template to be within reach, so a scoped user cannot take over a wider schedule by
 * narrowing it.
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly commands: CommandsService,
  ) {}

  async create(
    orgId: string,
    userId: string,
    clusterId: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(createScheduleBody, rawBody);
    await this.authorizeWrite(orgId, userId, clusterId, body, token);
    return this.commands.enqueue(orgId, clusterId, userId, 'CREATE_SCHEDULE', body);
  }

  async update(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(updateScheduleBody, rawBody);
    const row = await this.find(orgId, userId, clusterId, name, 'schedule:write', token);
    // The existing template too: rewriting a schedule is reaching what it backs up.
    const existing = templateCoverage(row.spec);
    await this.rbac.require(
      orgId,
      userId,
      {
        clusterId,
        permission: 'schedule:write',
        namespaces: existing.namespaces,
        includesClusterScoped: existing.includesClusterScoped,
      },
      token,
    );
    await this.authorizeWrite(orgId, userId, clusterId, body, token);
    return this.commands.enqueue(orgId, clusterId, userId, 'UPDATE_SCHEDULE', {
      name: row.name,
      ...body,
    });
  }

  async setPaused(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(pauseBody, rawBody);
    const row = await this.find(orgId, userId, clusterId, name, 'schedule:write', token);
    return this.commands.enqueue(orgId, clusterId, userId, 'SET_SCHEDULE_PAUSED', {
      name: row.name,
      paused: body.paused,
    });
  }

  async delete(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const row = await this.find(orgId, userId, clusterId, name, 'schedule:delete', token);
    return this.commands.enqueue(orgId, clusterId, userId, 'DELETE_SCHEDULE', { name: row.name });
  }

  private async authorizeWrite(
    orgId: string,
    userId: string,
    clusterId: string,
    body: UpdateScheduleBody,
    token?: TokenLimit,
  ): Promise<void> {
    const problem = checkSchedule(body);
    if (problem !== undefined) {
      throw new UnprocessableEntityException(problem);
    }
    if (
      body.advancedSpec !== undefined &&
      Buffer.byteLength(JSON.stringify(body.advancedSpec)) > MAX_ADVANCED_BYTES
    ) {
      throw new UnprocessableEntityException('advancedSpec is too large');
    }
    const covered = createCoverage(body.template);
    await this.rbac.require(
      orgId,
      userId,
      {
        clusterId,
        permission: 'schedule:write',
        namespaces: covered.namespaces,
        includesClusterScoped: covered.includesClusterScoped,
      },
      token,
    );
    if (body.advancedSpec !== undefined) {
      await this.rbac.require(
        orgId,
        userId,
        { clusterId, permission: 'advanced:write', namespaces: [] },
        token,
      );
    }
  }

  /** The schedule, or 404 whether it is missing or hidden from this caller (ADR-024). */
  private async find(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    permission: 'schedule:write' | 'schedule:delete',
    token?: TokenLimit,
  ) {
    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.findFirst({
        where: { clusterId, kind: 'SCHEDULE', name, deletedAt: null },
      }),
    );
    const visibility = await this.rbac.visibility(orgId, userId, clusterId, permission, token);
    if (row === null || !(visibility.all || visibility.sees(coveredBy('SCHEDULE', row.spec)))) {
      throw new NotFoundException('schedule not found');
    }
    return row;
  }
}
