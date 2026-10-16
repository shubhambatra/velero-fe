import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  authorize,
  mayAttempt,
  type AuthorizeRequest,
  type Decision,
  type Permission,
  type Principal,
  type RoleBinding,
} from '@vfm/shared';

import { parseOrgSettings } from '../auth/org-mfa-policy';
import { PrismaService } from '../prisma/prisma.service';

/** The narrowing an API token applies on top of its owner's grants. */
export interface TokenLimit {
  permissions: readonly string[] | null;
  clusterIds: readonly string[] | null;
}

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

  /**
   * 404 unless the cluster exists **in this org**. Without it, an Owner of org B
   * would get an empty 200 for a cluster id that belongs to org A (or to nobody),
   * which both confirms nothing and fails to say "not found".
   */
  async assertClusterInOrg(orgId: string, clusterId: string): Promise<void> {
    const cluster = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findUnique({ where: { id: clusterId }, select: { id: true } }),
    );
    if (cluster === null) {
      throw new NotFoundException('cluster not found');
    }
  }

  /** Everything `authorize()` needs for one user, one org, one cluster. */
  async load(orgId: string, userId: string, clusterId: string, token?: TokenLimit) {
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
      ...(token === undefined
        ? {}
        : { tokenLimit: { permissions: token.permissions, clusterIds: token.clusterIds } }),
    };
    const roleBindings: RoleBinding[] = bindings;
    const settings = parseOrgSettings(org?.settings);

    return {
      principal,
      bindings: roleBindings,
      context: { allowBackupContentDownload: settings.allowBackupContentDownload },
    };
  }

  /**
   * Which of `permissions` the user holds on each of `clusterIds`, in a fixed
   * number of queries regardless of how many clusters there are. The fleet page
   * needs this for every cluster at once; asking per cluster would be hundreds of
   * round trips for the same answer. It evaluates with the same pure engine as
   * every other check, so the two cannot disagree.
   */
  async matrix(
    orgId: string,
    userId: string,
    clusterIds: readonly string[],
    permissions: readonly Permission[],
    token?: TokenLimit,
  ): Promise<Map<string, Set<Permission>>> {
    const result = new Map<string, Set<Permission>>();
    if (clusterIds.length === 0) {
      return result;
    }
    const [membership, teams, bindings, org] = await this.prisma.inOrg(orgId, () =>
      Promise.all([
        this.prisma.membership.findUnique({
          where: { orgId_userId: { orgId, userId } },
          select: { orgRole: true },
        }),
        this.prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } }),
        this.prisma.roleBinding.findMany({
          where: { clusterId: { in: [...clusterIds] } },
          select: { clusterId: true, subjectType: true, subjectId: true, role: true, scope: true },
        }),
        this.prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } }),
      ]),
    );

    const principal: Principal = {
      userId,
      orgRole: membership?.orgRole,
      teamIds: teams.map((t) => t.teamId),
      ...(token === undefined
        ? {}
        : { tokenLimit: { permissions: token.permissions, clusterIds: token.clusterIds } }),
    };
    const context = {
      allowBackupContentDownload: parseOrgSettings(org?.settings).allowBackupContentDownload,
    };
    const byCluster = new Map<string, RoleBinding[]>();
    for (const binding of bindings) {
      const list = byCluster.get(binding.clusterId) ?? [];
      list.push(binding);
      byCluster.set(binding.clusterId, list);
    }

    for (const clusterId of clusterIds) {
      const mine = byCluster.get(clusterId) ?? [];
      const held = new Set<Permission>();
      for (const permission of permissions) {
        if (mayAttempt(principal, clusterId, permission, mine, context)) {
          held.add(permission);
        }
      }
      result.set(clusterId, held);
    }
    return result;
  }

  async decide(
    orgId: string,
    userId: string,
    request: AuthorizeRequest,
    token?: TokenLimit,
  ): Promise<{ decision: Decision; visible: boolean }> {
    const { principal, bindings, context } = await this.load(
      orgId,
      userId,
      request.clusterId,
      token,
    );
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
  async require(
    orgId: string,
    userId: string,
    request: AuthorizeRequest,
    token?: TokenLimit,
  ): Promise<void> {
    const { decision, visible } = await this.decide(orgId, userId, request, token);
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
    token?: TokenLimit,
  ): Promise<{ may: boolean; visible: boolean }> {
    const { principal, bindings, context } = await this.load(orgId, userId, clusterId, token);
    return {
      may: mayAttempt(principal, clusterId, permission, bindings, context),
      visible: mayAttempt(principal, clusterId, 'cluster:read', bindings, context),
    };
  }
}
