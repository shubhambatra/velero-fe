import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BUILT_IN_ROLES, normaliseScope, type BindingScope } from '@vfm/shared';

import { newId } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from './rbac.service';

export interface RoleBindingView {
  id: string;
  clusterId: string;
  subjectType: 'USER' | 'TEAM';
  subjectId: string;
  /** Email for a user, name for a team; `null` if the subject no longer resolves. */
  subjectName: string | null;
  role: string;
  scope: unknown;
  createdAt: Date;
}

export interface CreateRoleBindingInput {
  subjectType: 'USER' | 'TEAM';
  subjectId: string;
  role: string;
  scope: unknown;
}

/** Role bindings for one cluster (PLAN.md §8.2, §9 `role_bindings`). */
@Injectable()
export class RoleBindingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async list(orgId: string, clusterId: string): Promise<RoleBindingView[]> {
    const rows = await this.prisma.inOrg(orgId, async () => {
      const bindings = await this.prisma.roleBinding.findMany({
        where: { clusterId },
        orderBy: { createdAt: 'asc' },
      });
      const userIds = bindings.filter((b) => b.subjectType === 'USER').map((b) => b.subjectId);
      const teamIds = bindings.filter((b) => b.subjectType === 'TEAM').map((b) => b.subjectId);
      const [users, teams] = await Promise.all([
        this.prisma.membership.findMany({
          where: { userId: { in: userIds } },
          select: { user: { select: { id: true, email: true } } },
        }),
        this.prisma.team.findMany({
          where: { id: { in: teamIds } },
          select: { id: true, name: true },
        }),
      ]);
      const names = new Map<string, string>([
        ...users.map((m) => [m.user.id, m.user.email] as const),
        ...teams.map((t) => [t.id, t.name] as const),
      ]);
      return bindings.map((b) => ({ ...b, subjectName: names.get(b.subjectId) ?? null }));
    });

    return rows.map((b) => ({
      id: b.id,
      clusterId: b.clusterId,
      subjectType: b.subjectType,
      subjectId: b.subjectId,
      subjectName: b.subjectName,
      role: b.role,
      scope: b.scope,
      createdAt: b.createdAt,
    }));
  }

  async create(
    orgId: string,
    clusterId: string,
    actorId: string,
    input: CreateRoleBindingInput,
  ): Promise<RoleBindingView> {
    // Re-validated with the engine's own reader, so what is stored is exactly
    // what `authorize()` will later accept; the zod schema alone could drift.
    const scope = normaliseScope(input.scope);
    if (scope === null || !Object.hasOwn(BUILT_IN_ROLES, input.role)) {
      throw new UnprocessableEntityException('invalid role or scope');
    }

    const id = newId();
    try {
      await this.prisma.inOrg(orgId, () =>
        this.prisma.$transaction(
          async (tx) => {
            const subject =
              input.subjectType === 'USER'
                ? await tx.membership.findUnique({
                    where: { orgId_userId: { orgId, userId: input.subjectId } },
                    select: { id: true },
                  })
                : await tx.team.findUnique({
                    where: { id: input.subjectId },
                    select: { id: true },
                  });
            if (subject === null) {
              // The same answer for "no such user" and "user of another org".
              throw new NotFoundException('subject not found in this organization');
            }

            const existing = await tx.roleBinding.findMany({
              where: {
                clusterId,
                subjectType: input.subjectType,
                subjectId: input.subjectId,
                role: input.role,
              },
              select: { scope: true },
            });
            if (existing.some((e) => sameScope(normaliseScope(e.scope), scope))) {
              throw new ConflictException('that binding already exists');
            }

            await tx.roleBinding.create({
              data: {
                id,
                orgId,
                clusterId,
                subjectType: input.subjectType,
                subjectId: input.subjectId,
                role: input.role,
                scope: scope,
                createdById: actorId,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('concurrent change; retry');
      }
      throw error;
    }

    const created = (await this.list(orgId, clusterId)).find((b) => b.id === id);
    if (created === undefined) {
      throw new NotFoundException('role binding not found');
    }
    return created;
  }

  async remove(orgId: string, clusterId: string, bindingId: string): Promise<void> {
    const { count } = await this.prisma.inOrg(orgId, () =>
      this.prisma.roleBinding.deleteMany({ where: { id: bindingId, clusterId } }),
    );
    if (count === 0) {
      throw new NotFoundException('role binding not found');
    }
  }

  /** What the caller holds on a cluster, so the UI can show and hide controls. */
  async myAccess(orgId: string, userId: string, clusterId: string) {
    const { principal, bindings, context } = await this.rbac.load(orgId, userId, clusterId);
    const teams = new Set(principal.teamIds);
    const grants = bindings
      .filter((b) => (b.subjectType === 'USER' ? b.subjectId === userId : teams.has(b.subjectId)))
      .flatMap((b) => {
        const scope = normaliseScope(b.scope);
        if (scope === null || !Object.hasOwn(BUILT_IN_ROLES, b.role)) {
          return [];
        }
        return [
          {
            role: b.role,
            via: b.subjectType,
            scope,
            permissions: BUILT_IN_ROLES[b.role as keyof typeof BUILT_IN_ROLES],
          },
        ];
      });
    return {
      orgRole: principal.orgRole ?? null,
      // Owners and Admins are implicitly Cluster Admin everywhere (§8.2).
      implicitClusterAdmin: principal.orgRole === 'OWNER' || principal.orgRole === 'ADMIN',
      allowBackupContentDownload: context.allowBackupContentDownload,
      grants,
    };
  }
}

function sameScope(a: BindingScope | null, b: BindingScope): boolean {
  if (a === null || a.type !== b.type) {
    return false;
  }
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(scope: BindingScope): unknown {
  if (scope.type === 'NAMESPACES') {
    return { type: scope.type, namespaces: [...scope.namespaces].sort() };
  }
  if (scope.type === 'SELECTOR') {
    return {
      type: scope.type,
      labels: Object.entries(scope.selector.matchLabels).sort(([x], [y]) => x.localeCompare(y)),
    };
  }
  return scope;
}
