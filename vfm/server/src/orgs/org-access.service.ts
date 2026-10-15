import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { OrgRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const RANK: Record<OrgRole, number> = { MEMBER: 1, ADMIN: 2, OWNER: 3 };

export interface OrgMembership {
  orgId: string;
  userId: string;
  orgRole: OrgRole;
}

/**
 * Decides whether a caller may act inside an organization (PLAN.md §8.1).
 *
 * Membership is the only way in. A platform admin is **not** implicitly a
 * member of every org: §8.1 gives that flag the job of bootstrapping the first
 * org, not of reading everyone's data, so it gets no standing access here.
 *
 * A non-member gets **404**, the same answer as for an org that does not exist
 * — a 403 would confirm that the id is real.
 */
@Injectable()
export class OrgAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async require(
    userId: string,
    orgId: string,
    minimum: OrgRole = 'MEMBER',
  ): Promise<OrgMembership> {
    const membership = await this.prisma.inOrg(orgId, () =>
      this.prisma.membership.findUnique({
        where: { orgId_userId: { orgId, userId } },
        select: { orgId: true, userId: true, orgRole: true },
      }),
    );

    if (membership === null) {
      throw new NotFoundException('organization not found');
    }

    if (RANK[membership.orgRole] < RANK[minimum]) {
      throw new ForbiddenException(`requires the ${minimum.toLowerCase()} role`);
    }

    return membership;
  }

  /** Whether `actor` may grant or revoke `role`. Only an Owner touches Owners. */
  static canAssign(actor: OrgRole, role: OrgRole): boolean {
    return role === 'OWNER' ? actor === 'OWNER' : RANK[actor] >= RANK.ADMIN;
  }
}
