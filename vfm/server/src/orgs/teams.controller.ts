import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { OrgAccessService } from './org-access.service';
import { createTeamSchema, orgIdParam, updateTeamSchema } from './orgs.dto';
import { TeamsService } from './teams.service';

/** `/orgs/{orgId}/teams` (PLAN.md §8.1, §10). Reads: members. Writes: Owner/Admin. */
@ApiTags('teams')
@Controller('orgs/:orgId/teams')
export class TeamsController {
  constructor(
    private readonly teams: TeamsService,
    private readonly access: OrgAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List teams' })
  async list(@CurrentUser() user: AuthenticatedUser, @Param('orgId') orgId: string) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id);
    return { teams: await this.teams.list(id) };
  }

  @Post()
  @ApiOperation({ summary: 'Create a team (Owner/Admin)' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return this.teams.create(id, parseBody(createTeamSchema, body));
  }

  @Patch(':teamId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Rename or describe a team (Owner/Admin)' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    await this.teams.update(id, parseBody(orgIdParam, teamId), parseBody(updateTeamSchema, body));
  }

  @Delete(':teamId')
  @RequiresSudo()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a team (Owner/Admin, sudo required)' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('teamId') teamId: string,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    await this.teams.remove(id, parseBody(orgIdParam, teamId));
  }

  @Get(':teamId/members')
  @ApiOperation({ summary: 'Members of a team' })
  async members(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('teamId') teamId: string,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id);
    return { members: await this.teams.listMembers(id, parseBody(orgIdParam, teamId)) };
  }

  @Put(':teamId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Add an org member to a team (Owner/Admin)' })
  async addMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    await this.teams.addMember(id, parseBody(orgIdParam, teamId), parseBody(orgIdParam, userId));
  }

  @Delete(':teamId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member from a team (Owner/Admin)' })
  async removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    await this.teams.removeMember(id, parseBody(orgIdParam, teamId), parseBody(orgIdParam, userId));
  }
}
