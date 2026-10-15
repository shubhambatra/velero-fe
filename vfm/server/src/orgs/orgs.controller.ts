import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import {
  changeRoleSchema,
  createOrgSchema,
  orgIdParam,
  setActiveOrgSchema,
  updateOrgSchema,
} from './orgs.dto';
import { OrgAccessService } from './org-access.service';
import { OrgsService } from './orgs.service';

/**
 * `/me/orgs`, `/orgs/{orgId}` and members (PLAN.md §10).
 *
 * Every `/orgs/{orgId}/…` route starts with `OrgAccessService.require`, which
 * is what turns the path parameter from a claim into a fact.
 */
@ApiTags('orgs')
@Controller()
export class OrgsController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly access: OrgAccessService,
  ) {}

  @Get('me/orgs')
  @ApiOperation({ summary: 'Organizations the caller belongs to (org switcher)' })
  async myOrgs(@CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    return { orgs: await this.orgs.listForUser(user.id, request.session?.activeOrgId) };
  }

  @Post('me/active-org')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Switch the active organization' })
  async setActive(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<void> {
    const { orgId } = parseBody(setActiveOrgSchema, body);
    const session = request.session;
    if (session === undefined) {
      throw new ForbiddenException();
    }
    await this.orgs.setActive(user.id, session.id, orgId, this.access);
  }

  @Post('orgs')
  @ApiOperation({
    summary: 'Create an organization',
    description:
      'Platform administrators only. PLAN.md §8.1: the platform admin bootstraps orgs; there is no open org creation. The creator becomes the first Owner.',
  })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    if (!user.isPlatformAdmin) {
      throw new ForbiddenException('only platform administrators create organizations');
    }
    return this.orgs.create(user.id, parseBody(createOrgSchema, body));
  }

  @Get('orgs/:orgId')
  @ApiOperation({ summary: 'Organization details and settings' })
  async get(@CurrentUser() user: AuthenticatedUser, @Param('orgId') orgId: string) {
    const id = parseBody(orgIdParam, orgId);
    const membership = await this.access.require(user.id, id);
    return { ...(await this.orgs.get(id)), orgRole: membership.orgRole };
  }

  @Patch('orgs/:orgId')
  @ApiOperation({ summary: 'Update the name or MFA policy (Owner/Admin)' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return this.orgs.update(id, parseBody(updateOrgSchema, body));
  }

  @Get('orgs/:orgId/members')
  @ApiOperation({ summary: 'Members of the organization' })
  async members(@CurrentUser() user: AuthenticatedUser, @Param('orgId') orgId: string) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id);
    return { members: await this.orgs.listMembers(id) };
  }

  @Patch('orgs/:orgId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change a member’s org role (Owner/Admin)' })
  async changeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    const target = parseBody(orgIdParam, userId);
    const actor = await this.access.require(user.id, id, 'ADMIN');
    const { orgRole } = parseBody(changeRoleSchema, body);
    await this.orgs.changeRole(id, actor, target, orgRole);
  }

  @Delete('orgs/:orgId/members/:userId')
  @RequiresSudo()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member, or leave (sudo required)' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    const target = parseBody(orgIdParam, userId);
    const actor = await this.access.require(user.id, id);
    await this.orgs.removeMember(id, actor, target);
  }
}
