import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  authorize,
  mayAttempt,
  type AuthorizeRequest,
  type Decision,
  type Principal,
  type RoleBinding,
} from '@vfm/shared';

import { parseOrgSettings } from '../auth/org-mfa-policy';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Loads the facts RBAC needs (membership, teams, bindings, org settings) and
 * hands them to the pure `authorize()` in `@vfm/shared` (PLAN.md §8.2).
 *
 * This class decides nothing itself. It exists so the decision function stays
 * free of I/O and can be tested exhaustively on its own.
 */
@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  /** Everything `authorize()` needs for one user, one org, one cluster. */
  async load(orgId: string, userId: string, clusterId: string) {
    const [membership, teams, bindings, org] = await this.prisma.inOrg(orgId, () =>
      Promise.all([
        this.prisma.membership.findUnique({
          where: { orgId_userId: { orgId, userId } },
          select: { orgRole: true },
        }),
        this.prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } }),
        this.prisma.roleBinding.findMany({
          where: { clusterId },
          select: {
            clusterId: true,
            subjectType: true,
            subjectId: true,
            role: true,
            scope: true,
          },
        }),
        this.prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } }),
      ]),
    );

    const principal: Principal = {
      userId,
      orgRole: membership?.orgRole,
      teamIds: teams.map((t) => t.teamId),
    };
    const roleBindings: RoleBinding[] = bindings;
    const settings = parseOrgSettings(org?.settings);

    return {
      principal,
      bindings: roleBindings,
      context: { allowBackupContentDownload: settings.allowBackupContentDownload },
    };
  }

  async decide(
    orgId: string,
    userId: string,
    request: AuthorizeRequest,
  ): Promise<{ decision: Decision; visible: boolean }> {
    const { principal, bindings, context } = await this.load(orgId, userId, request.clusterId);
    const decision = authorize(principal, request, bindings, context);
    // "Visible" = the caller can at least see the cluster. Used to choose
    // between 404 and 403 so a cluster id is not confirmed to outsiders.
    const visible = mayAttempt(principal, request.clusterId, 'cluster:read', bindings, context);
    return { decision, visible };
  }

  /**
   * Throws unless allowed: **404** when the caller cannot see the cluster at
   * all, **403** when they can see it but lack the permission.
   */
  async require(orgId: string, userId: string, request: AuthorizeRequest): Promise<void> {
    const { decision, visible } = await this.decide(orgId, userId, request);
    if (decision.allowed) {
      return;
    }
    if (!visible) {
      throw new NotFoundException('cluster not found');
    }
    throw new ForbiddenException(`missing permission ${request.permission}`);
  }

  /** Whether the user could pass at least some check for this permission. */
  async mayAttempt(
    orgId: string,
    userId: string,
    clusterId: string,
    permission: string,
  ): Promise<{ may: boolean; visible: boolean }> {
    const { principal, bindings, context } = await this.load(orgId, userId, clusterId);
    return {
      may: mayAttempt(principal, clusterId, permission, bindings, context),
      visible: mayAttempt(principal, clusterId, 'cluster:read', bindings, context),
    };
  }
}
