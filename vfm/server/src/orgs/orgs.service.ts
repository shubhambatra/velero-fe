import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type OrgRole } from '@prisma/client';

import { SessionService } from '../auth/session.service';
import { parseOrgSettings } from '../auth/org-mfa-policy';
import { newId } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { OrgAccessService } from './org-access.service';

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  orgRole: OrgRole;
  active: boolean;
}

export interface MemberView {
  userId: string;
  email: string;
  name: string | null;
  orgRole: OrgRole;
  mfaEnabled: boolean;
  joinedAt: string;
}

/** Organizations and their members (PLAN.md §8.1, §16 day 6). */
@Injectable()
export class OrgsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  /** The orgs a user belongs to — the org switcher's data. */
  async listForUser(userId: string, activeOrgId: string | null | undefined): Promise<OrgSummary[]> {
    const rows = await this.prisma.unscoped(
      'a user lists their own memberships (org switcher)',
      () =>
        this.prisma.membership.findMany({
          where: { userId },
          select: { orgRole: true, org: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'asc' },
        }),
    );
    const fallback = rows[0]?.org.id;
    const active =
      activeOrgId !== null &&
      activeOrgId !== undefined &&
      rows.some((r) => r.org.id === activeOrgId)
        ? activeOrgId
        : fallback;
    return rows.map((row) => ({
      id: row.org.id,
      name: row.org.name,
      slug: row.org.slug,
      orgRole: row.orgRole,
      active: row.org.id === active,
    }));
  }

  /** Records the org the UI is showing. Membership is re-checked, never assumed. */
  async setActive(
    userId: string,
    sessionId: string,
    orgId: string,
    access: OrgAccessService,
  ): Promise<void> {
    await access.require(userId, orgId);
    await this.sessions.update(sessionId, { activeOrgId: orgId });
  }

  /** Platform-admin-only: creates an org and makes the creator its first Owner. */
  async create(
    creatorId: string,
    input: { name: string; slug: string },
  ): Promise<{ id: string; name: string; slug: string }> {
    const id = newId();
    try {
      return await this.prisma.inOrg(id, () =>
        this.prisma.$transaction(async (tx) => {
          const org = await tx.organization.create({
            data: { id, name: input.name, slug: input.slug, settings: {} },
            select: { id: true, name: true, slug: true },
          });
          await tx.membership.create({
            data: { id: newId(), orgId: id, userId: creatorId, orgRole: 'OWNER' },
          });
          return org;
        }),
      );
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('an organization with that slug already exists');
      }
      throw error;
    }
  }

  async get(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true, settings: true, createdAt: true },
    });
    if (org === null) {
      throw new NotFoundException('organization not found');
    }
    return { ...org, settings: parseOrgSettings(org.settings) };
  }

  async update(
    orgId: string,
    input: {
      name?: string | undefined;
      mfaRequired?: boolean | undefined;
      allowBackupContentDownload?: boolean | undefined;
    },
  ) {
    const current = await this.get(orgId);
    const settings = {
      ...current.settings,
      ...(input.mfaRequired === undefined ? {} : { mfaRequired: input.mfaRequired }),
      ...(input.allowBackupContentDownload === undefined
        ? {}
        : { allowBackupContentDownload: input.allowBackupContentDownload }),
    };
    await this.prisma.organization.update({
      where: { id: orgId },
      data: { ...(input.name === undefined ? {} : { name: input.name }), settings },
    });
    return this.get(orgId);
  }

  async listMembers(orgId: string): Promise<MemberView[]> {
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.membership.findMany({
        where: {},
        select: {
          orgRole: true,
          createdAt: true,
          user: { select: { id: true, email: true, name: true, mfaEnabled: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((row) => ({
      userId: row.user.id,
      email: row.user.email,
      name: row.user.name,
      orgRole: row.orgRole,
      mfaEnabled: row.user.mfaEnabled,
      joinedAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Changes a member's role.
   *
   * Serializable so the "never leave an org without an Owner" check and the
   * write are one atomic decision: under read-committed, two Owners demoting
   * each other at once would each see the other as still an Owner.
   */
  async changeRole(
    orgId: string,
    actor: { userId: string; orgRole: OrgRole },
    targetUserId: string,
    role: OrgRole,
  ): Promise<void> {
    if (!OrgAccessService.canAssign(actor.orgRole, role)) {
      throw new ForbiddenException('only an owner may grant the owner role');
    }

    await this.prisma.inOrg(orgId, () =>
      this.prisma.$transaction(
        async (tx) => {
          const target = await tx.membership.findUnique({
            where: { orgId_userId: { orgId, userId: targetUserId } },
            select: { orgRole: true },
          });
          if (target === null) {
            throw new NotFoundException('member not found');
          }
          if (target.orgRole === 'OWNER' && actor.orgRole !== 'OWNER') {
            throw new ForbiddenException('only an owner may change an owner');
          }
          if (target.orgRole === 'OWNER' && role !== 'OWNER') {
            await this.assertAnotherOwner(tx, orgId, targetUserId);
          }
          await tx.membership.update({
            where: { orgId_userId: { orgId, userId: targetUserId } },
            data: { orgRole: role },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    // PLAN.md §8.3: rotate on privilege change. The target's other sessions
    // were issued under the old role, so they end here.
    await this.sessions.destroyAllForUser(targetUserId);
  }

  async removeMember(
    orgId: string,
    actor: { userId: string; orgRole: OrgRole },
    targetUserId: string,
  ): Promise<void> {
    await this.prisma.inOrg(orgId, () =>
      this.prisma.$transaction(
        async (tx) => {
          const target = await tx.membership.findUnique({
            where: { orgId_userId: { orgId, userId: targetUserId } },
            select: { orgRole: true },
          });
          if (target === null) {
            throw new NotFoundException('member not found');
          }
          const self = targetUserId === actor.userId;
          if (
            !self &&
            (actor.orgRole === 'MEMBER' ||
              (target.orgRole === 'OWNER' && actor.orgRole !== 'OWNER'))
          ) {
            throw new ForbiddenException('not permitted to remove this member');
          }
          if (target.orgRole === 'OWNER') {
            await this.assertAnotherOwner(tx, orgId, targetUserId);
          }
          await tx.teamMember.deleteMany({ where: { userId: targetUserId } });
          // Otherwise re-inviting the person later would silently restore
          // access granted before they left.
          await tx.roleBinding.deleteMany({
            where: { subjectType: 'USER', subjectId: targetUserId },
          });
          await tx.membership.delete({
            where: { orgId_userId: { orgId, userId: targetUserId } },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    await this.sessions.destroyAllForUser(targetUserId);
  }

  private async assertAnotherOwner(
    tx: Prisma.TransactionClient,
    orgId: string,
    excluding: string,
  ): Promise<void> {
    const others = await tx.membership.count({
      where: { orgId, orgRole: 'OWNER', userId: { not: excluding } },
    });
    if (others === 0) {
      throw new ConflictException('an organization must keep at least one owner');
    }
  }
}
