import { Injectable } from '@nestjs/common';

import { parseOrgSettings } from '../auth/org-mfa-policy';
import { PrismaService } from '../prisma/prisma.service';

export interface ApprovalPolicy {
  /** A restore on this cluster waits for someone else to approve it. */
  required: boolean;
  /** The org requires it everywhere; a cluster cannot opt out. */
  fromOrg: boolean;
  /** This cluster asks for it on its own. */
  fromCluster: boolean;
}

/**
 * Whether restores on a cluster need approval (PLAN.md §8.4). The org setting is a floor and
 * the cluster setting only adds: otherwise whoever administers one cluster could switch off
 * a control the org decided to impose.
 */
@Injectable()
export class ApprovalPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async forCluster(orgId: string, clusterId: string): Promise<ApprovalPolicy> {
    const [org, cluster] = await this.prisma.inOrg(orgId, () =>
      Promise.all([
        this.prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } }),
        this.prisma.cluster.findUnique({
          where: { id: clusterId },
          select: { requireRestoreApproval: true },
        }),
      ]),
    );
    const fromOrg = parseOrgSettings(org?.settings).requireRestoreApproval;
    const fromCluster = cluster?.requireRestoreApproval === true;
    return { required: fromOrg || fromCluster, fromOrg, fromCluster };
  }

  async setForCluster(
    orgId: string,
    clusterId: string,
    required: boolean,
  ): Promise<ApprovalPolicy> {
    await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.update({
        where: { id: clusterId },
        data: { requireRestoreApproval: required },
      }),
    );
    return this.forCluster(orgId, clusterId);
  }
}
