import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { newId } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
}

/** Teams within an org (PLAN.md §8.1, §9 `teams` / `team_members`). */
@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(orgId: string): Promise<TeamView[]> {
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.team.findMany({
        select: { id: true, name: true, description: true, _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      memberCount: r._count.members,
    }));
  }

  async create(
    orgId: string,
    input: { name: string; description?: string | undefined },
  ): Promise<TeamView> {
    try {
      const team = await this.prisma.inOrg(orgId, () =>
        this.prisma.team.create({
          data: { id: newId(), orgId, name: input.name, description: input.description ?? null },
        }),
      );
      return { id: team.id, name: team.name, description: team.description, memberCount: 0 };
    } catch (error: unknown) {
      throw conflictOn(error, 'a team with that name already exists');
    }
  }

  async update(
    orgId: string,
    teamId: string,
    input: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<void> {
    try {
      await this.prisma.inOrg(orgId, () =>
        this.prisma.team.update({
          where: { id: teamId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
          },
        }),
      );
    } catch (error: unknown) {
      throw notFoundOn(conflictOn(error, 'a team with that name already exists'));
    }
  }

  async remove(orgId: string, teamId: string): Promise<void> {
    try {
      await this.prisma.inOrg(orgId, () => this.prisma.team.delete({ where: { id: teamId } }));
    } catch (error: unknown) {
      throw notFoundOn(error);
    }
  }

  async listMembers(orgId: string, teamId: string) {
    await this.assertTeam(orgId, teamId);
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.teamMember.findMany({
        where: { teamId },
        select: { user: { select: { id: true, email: true, name: true } } },
      }),
    );
    return rows.map((r) => r.user);
  }

  async addMember(orgId: string, teamId: string, userId: string): Promise<void> {
    await this.assertTeam(orgId, teamId);
    await this.prisma.inOrg(orgId, async () => {
      // Team membership is a subset of org membership. Without this check an
      // admin could place any user id from another org into a team here.
      const member = await this.prisma.membership.findUnique({
        where: { orgId_userId: { orgId, userId } },
        select: { id: true },
      });
      if (member === null) {
        throw new NotFoundException('that user is not a member of this organization');
      }
      try {
        await this.prisma.teamMember.create({ data: { id: newId(), orgId, teamId, userId } });
      } catch (error: unknown) {
        throw conflictOn(error, 'already a member of this team');
      }
    });
  }

  async removeMember(orgId: string, teamId: string, userId: string): Promise<void> {
    const { count } = await this.prisma.inOrg(orgId, () =>
      this.prisma.teamMember.deleteMany({ where: { teamId, userId } }),
    );
    if (count === 0) {
      throw new NotFoundException('team member not found');
    }
  }

  private async assertTeam(orgId: string, teamId: string): Promise<void> {
    const team = await this.prisma.inOrg(orgId, () =>
      this.prisma.team.findUnique({ where: { id: teamId }, select: { id: true } }),
    );
    if (team === null) {
      throw new NotFoundException('team not found');
    }
  }
}

function conflictOn(error: unknown, message: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException(message);
  }
  return error;
}

function notFoundOn(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    return new NotFoundException('not found');
  }
  return error;
}
