import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

import { ApprovalPolicyService } from '../approvals/approval-policy.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { CommandsService, type CommandView } from '../commands/commands.service';
import { parseBody } from '../common/parse-body';
import { coveredBy } from '../inventory/projections';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService, type TokenLimit } from '../rbac/rbac.service';
import {
  checkRestoreDurations,
  createRestoreBody,
  impactBody,
  restoreCoverage,
} from './restore-request';

const MAX_ADVANCED_BYTES = 256 * 1024;

/**
 * Restore operations (PLAN.md §6, §16 day 23). A restore writes into a cluster, so it is
 * authorized over every namespace it reads **and** writes (after mapping), needs a recent
 * re-authentication (enforced on the route) and is checked again by the agent against the
 * cluster owner's own policy, which the control plane cannot change (PLAN.md §5.5).
 */
@Injectable()
export class RestoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly commands: CommandsService,
    private readonly policy: ApprovalPolicyService,
    private readonly approvals: ApprovalsService,
  ) {}

  async create(
    orgId: string,
    userId: string,
    clusterId: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(createRestoreBody, rawBody);
    const problem = checkRestoreDurations(body);
    if (problem !== undefined) {
      throw new UnprocessableEntityException(problem);
    }
    if (
      body.advancedSpec !== undefined &&
      Buffer.byteLength(JSON.stringify(body.advancedSpec)) > MAX_ADVANCED_BYTES
    ) {
      throw new UnprocessableEntityException('advancedSpec is too large');
    }

    const covered = restoreCoverage(body);
    await this.rbac.require(
      orgId,
      userId,
      {
        clusterId,
        permission: 'restore:create',
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
    // On a cluster that needs approval the request is recorded and waits; the agent hears of it
    // only once someone else approves (PLAN.md §8.4).
    const { required } = await this.policy.forCluster(orgId, clusterId);
    const created = await this.commands.enqueue(
      orgId,
      clusterId,
      userId,
      'CREATE_RESTORE',
      body,
      undefined,
      { pendingApproval: required },
    );
    if (required) {
      void this.approvals.announceRequest(orgId, created.id);
    }
    return created;
  }

  /**
   * Asks the agent which of the named namespaces exist now, for the wizard's impact
   * summary. The caller must be allowed to restore into **every** name asked about, so
   * this can never be used to find out whether some other namespace exists; the agent
   * answers for those names alone.
   */
  async impact(
    orgId: string,
    userId: string,
    clusterId: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(impactBody, rawBody);
    await this.rbac.require(
      orgId,
      userId,
      {
        clusterId,
        permission: 'restore:create',
        namespaces: [...new Set(body.namespaces)],
        includesClusterScoped: false,
      },
      token,
    );
    return this.commands.enqueue(orgId, clusterId, userId, 'CHECK_NAMESPACES', {
      names: [...new Set(body.namespaces)],
    });
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
        where: { clusterId, kind: 'RESTORE', name, deletedAt: null },
      }),
    );
    const visibility = await this.rbac.visibility(
      orgId,
      userId,
      clusterId,
      'restore:delete',
      token,
    );
    // Hidden and missing answer the same (ADR-024); a restore covers its mapped targets too.
    if (row === null || !(visibility.all || visibility.sees(coveredBy('RESTORE', row.spec)))) {
      throw new NotFoundException('restore not found');
    }
    return this.commands.enqueue(orgId, clusterId, userId, 'DELETE_RESTORE', { name: row.name });
  }
}
