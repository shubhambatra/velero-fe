import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { CommandsService, type CommandView } from '../commands/commands.service';
import { parseBody } from '../common/parse-body';
import { coveredBy } from '../inventory/projections';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService, type TokenLimit } from '../rbac/rbac.service';
import { templateCoverage } from '../schedules/schedule-request';
import { checkDurations, createBackupBody, createCoverage, triggerBody } from './backup-request';

/** The advanced escape hatch is bounded: a spec has no business being larger. */
const MAX_ADVANCED_BYTES = 256 * 1024;

/**
 * Backup operations: create, delete, and run a schedule now (PLAN.md §6, §16 day 21).
 *
 * Each one is authorized here, with the namespaces the operation really reaches,
 * because a route guard cannot know them (ADR-024). The agent applies its own policy
 * as well, so a compromised control plane still cannot do more than the cluster's
 * owner allowed (PLAN.md §5.5). The result is a queued command, not a finished
 * backup: callers follow the command and the inventory.
 */
@Injectable()
export class BackupsService {
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
    const body = parseBody(createBackupBody, rawBody);
    const problem = checkDurations(body);
    if (problem !== undefined) {
      throw new UnprocessableEntityException(problem);
    }
    if (
      body.advancedSpec !== undefined &&
      Buffer.byteLength(JSON.stringify(body.advancedSpec)) > MAX_ADVANCED_BYTES
    ) {
      throw new UnprocessableEntityException('advancedSpec is too large');
    }

    const covered = createCoverage(body);
    await this.rbac.require(
      orgId,
      userId,
      {
        clusterId,
        permission: 'backup:create',
        namespaces: covered.namespaces,
        includesClusterScoped: covered.includesClusterScoped,
      },
      token,
    );
    if (body.advancedSpec !== undefined) {
      // The escape hatch can say anything the typed fields cannot, so it is for
      // whole-cluster administrators only.
      await this.rbac.require(
        orgId,
        userId,
        { clusterId, permission: 'advanced:write', namespaces: [] },
        token,
      );
    }
    return this.commands.enqueue(orgId, clusterId, userId, 'CREATE_BACKUP', body);
  }

  async delete(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.findFirst({
        where: { clusterId, kind: 'BACKUP', name, deletedAt: null },
      }),
    );
    const visibility = await this.rbac.visibility(orgId, userId, clusterId, 'backup:delete', token);
    // Hidden and missing answer the same (ADR-024).
    if (row === null || !(visibility.all || visibility.sees(coveredBy('BACKUP', row.spec)))) {
      throw new NotFoundException('backup not found');
    }
    if (row.phase === 'Deleting') {
      throw new ConflictException('this backup is already being deleted');
    }
    return this.commands.enqueue(orgId, clusterId, userId, 'DELETE_BACKUP', {
      name: row.name,
      uid: row.uid,
    });
  }

  async trigger(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(triggerBody, rawBody ?? {});
    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.findFirst({
        where: { clusterId, kind: 'SCHEDULE', name, deletedAt: null },
      }),
    );
    const readable = await this.rbac.visibility(orgId, userId, clusterId, 'schedule:read', token);
    if (row === null || !(readable.all || readable.sees(coveredBy('SCHEDULE', row.spec)))) {
      throw new NotFoundException('schedule not found');
    }

    // What the backup would reach, by the same rule as a backup made by hand.
    const covered = templateCoverage(row.spec);
    await this.rbac.require(
      orgId,
      userId,
      {
        clusterId,
        permission: 'backup:create',
        namespaces: covered.namespaces,
        includesClusterScoped: covered.includesClusterScoped,
      },
      token,
    );
    return this.commands.enqueue(orgId, clusterId, userId, 'TRIGGER_SCHEDULE', {
      scheduleName: row.name,
      ...(body.backupName === undefined ? {} : { backupName: body.backupName }),
    });
  }
}
