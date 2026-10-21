import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  authorize,
  isNamespaced,
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
 * How long the facts behind one request's authorization are reused. A grant that is
 * revoked stops working within this window; the load test (docs/LOADTEST.md) showed
 * five queries per request before the handler even ran. Tests set it to 0.
 */
export const rbacOptions = { cacheMs: 2_000 };

const CACHE_CAP = 20_000;

/**
 * Loads the facts RBAC needs (membership, teams, bindings, org settings) and
 * hands them to the pure `authorize()` in `@vfm/shared` (PLAN.md §8.2).
 *
 * This class decides nothing itself. It exists so the decision function stays
 * free of I/O and can be tested exhaustively on its own.
 */
interface LoadedFacts {
  membership: { orgRole: 'OWNER' | 'ADMIN' | 'MEMBER' } | null;
  teams: { teamId: string }[];
  bindings: RoleBinding[];
  org: { settings: unknown } | null;
}

@Injectable()
export class RbacService {
  private readonly clusterSeen = new Map<string, number>();
  private readonly loaded = new Map<string, { at: number; value: Promise<LoadedFacts> }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 404 unless the cluster exists **in this org**. Without it, an Owner of org B
   * would get an empty 200 for a cluster id that belongs to org A (or to nobody),
   * which both confirms nothing and fails to say "not found".
   */
  async assertClusterInOrg(orgId: string, clusterId: string): Promise<void> {
    const key = `${orgId}\0${clusterId}`;
    const seen = this.clusterSeen.get(key);
    if (seen !== undefined && Date.now() - seen < rbacOptions.cacheMs) return;
    const cluster = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findUnique({ where: { id: clusterId }, select: { id: true } }),
    );
    if (cluster === null) {
      throw new NotFoundException('cluster not found');
    }
    if (rbacOptions.cacheMs > 0) {
      if (this.clusterSeen.size >= CACHE_CAP) this.clusterSeen.clear();
      this.clusterSeen.set(key, Date.now());
    }
  }

  /** Everything `authorize()` needs for one user, one org, one cluster. */
  async load(orgId: string, userId: string, clusterId: string, token?: TokenLimit) {
    const facts = await this.cachedFacts(orgId, userId, clusterId);
    const { membership, teams, bindings, org } = facts;
    return this.assemble(userId, membership, teams, bindings, org, token);
  }

  /** Concurrent requests of one user for one cluster share one set of queries. */
  private cachedFacts(orgId: string, userId: string, clusterId: string): Promise<LoadedFacts> {
    const key = `${orgId}\0${userId}\0${clusterId}`;
    const hit = this.loaded.get(key);
    if (hit !== undefined && Date.now() - hit.at < rbacOptions.cacheMs) return hit.value;
    const value = this.readFacts(orgId, userId, clusterId);
    if (rbacOptions.cacheMs > 0) {
      if (this.loaded.size >= CACHE_CAP) this.loaded.clear();
      this.loaded.set(key, { at: Date.now(), value });
      value.catch(() => this.loaded.delete(key));
    }
    return value;
  }

  private async readFacts(orgId: string, userId: string, clusterId: string): Promise<LoadedFacts> {
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
    return { membership, teams, bindings, org };
  }

  private assemble(
    userId: string,
    membership: LoadedFacts['membership'],
    teams: LoadedFacts['teams'],
    bindings: LoadedFacts['bindings'],
    org: LoadedFacts['org'],
    token?: TokenLimit,
  ) {
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
    const { principal, byCluster, context } = await this.loadMany(orgId, userId, clusterIds, token);
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

  /**
   * What `permissions` the user holds on **every cluster of the org**, in a fixed number of
   * queries. For the live event stream, which would otherwise ask per cluster and per kind.
   */
  async heldAcrossOrg(
    orgId: string,
    userId: string,
    permissions: readonly Permission[],
  ): Promise<Map<string, Set<Permission>>> {
    const clusters = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findMany({ select: { id: true } }),
    );
    return this.matrix(
      orgId,
      userId,
      clusters.map((c) => c.id),
      permissions,
    );
  }

  /** The facts for many clusters in a fixed number of queries (four), not four per cluster. */
  private async loadMany(
    orgId: string,
    userId: string,
    clusterIds: readonly string[],
    token?: TokenLimit,
  ) {
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
    return { principal, byCluster, context };
  }

  /**
   * {@link visibility} for many clusters at once, from the same four queries. The reports cover
   * every cluster a person can read; asking per cluster was two hundred round trips of four
   * queries each for one page.
   */
  async visibilities(
    orgId: string,
    userId: string,
    clusterIds: readonly string[],
    permission: Permission,
    token?: TokenLimit,
  ): Promise<
    Map<
      string,
      {
        all: boolean;
        sees: (covered: { namespaces: string[]; includesClusterScoped: boolean }) => boolean;
      }
    >
  > {
    const out = new Map<
      string,
      {
        all: boolean;
        sees: (covered: { namespaces: string[]; includesClusterScoped: boolean }) => boolean;
      }
    >();
    if (clusterIds.length === 0) {
      return out;
    }
    const { principal, byCluster, context } = await this.loadMany(orgId, userId, clusterIds, token);
    for (const clusterId of clusterIds) {
      const bindings = byCluster.get(clusterId) ?? [];
      const whole = authorize(
        principal,
        { clusterId, permission, namespaces: ['*'], includesClusterScoped: true },
        bindings,
        context,
      );
      out.set(clusterId, {
        all: whole.allowed,
        sees: (covered) =>
          authorize(
            principal,
            {
              clusterId,
              permission,
              namespaces: covered.namespaces,
              includesClusterScoped: covered.includesClusterScoped,
            },
            bindings,
            context,
          ).allowed,
      });
    }
    return out;
  }

  /**
   * A predicate for "may this user see an object that covers these namespaces",
   * for list and detail endpoints (PLAN.md §8.2). It loads the facts once and then
   * decides each object with the same pure `authorize()` as every other check, so a
   * list can filter instead of failing and cannot disagree with a direct request.
   *
   * `all` is true when the user holds the permission across the whole cluster, in
   * which case nothing needs filtering.
   */
  async visibility(
    orgId: string,
    userId: string,
    clusterId: string,
    permission: Permission,
    token?: TokenLimit,
  ): Promise<{
    all: boolean;
    sees: (covered: { namespaces: string[]; includesClusterScoped: boolean }) => boolean;
  }> {
    const { principal, bindings, context } = await this.load(orgId, userId, clusterId, token);
    const whole = authorize(
      principal,
      { clusterId, permission, namespaces: ['*'], includesClusterScoped: true },
      bindings,
      context,
    );
    return {
      all: whole.allowed,
      sees: (covered) =>
        authorize(
          principal,
          {
            clusterId,
            permission,
            namespaces: covered.namespaces,
            includesClusterScoped: covered.includesClusterScoped,
          },
          bindings,
          context,
        ).allowed,
    };
  }

  /**
   * What the caller may do on a cluster, for the UI to disable what would be refused
   * (PLAN.md §11.2). `cluster` is the permission across the whole cluster, `scoped`
   * only inside some namespaces, `none` not at all. It never replaces a check: every
   * request is still authorized by itself.
   */
  async access(
    orgId: string,
    userId: string,
    clusterId: string,
    permissions: readonly Permission[],
    token?: TokenLimit,
  ): Promise<Record<string, 'cluster' | 'scoped' | 'none'>> {
    const { principal, bindings, context } = await this.load(orgId, userId, clusterId, token);
    const out: Record<string, 'cluster' | 'scoped' | 'none'> = {};
    for (const permission of permissions) {
      const whole = authorize(
        principal,
        { clusterId, permission, namespaces: ['*'], includesClusterScoped: true },
        bindings,
        context,
      );
      // A cluster-level permission (storage:write, advanced:write, ...) cannot be held
      // for some namespaces only: without a whole-cluster binding it is not held.
      out[permission] = whole.allowed
        ? 'cluster'
        : isNamespaced(permission) &&
            mayAttempt(principal, clusterId, permission, bindings, context)
          ? 'scoped'
          : 'none';
    }
    return out;
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
