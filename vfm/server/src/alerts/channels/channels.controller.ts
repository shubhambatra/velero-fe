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
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { setAuditContext } from '../../audit/audit.middleware';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { CurrentUser } from '../../auth/current-user.decorator';
import { RequiresSudo } from '../../auth/sudo.guard';
import { parseBody } from '../../common/parse-body';
import { OrgAccessService } from '../../orgs/org-access.service';
import { orgIdParam } from '../../orgs/orgs.dto';
import { ChannelsService, createChannelSchema, updateChannelSchema } from './channels.service';

/**
 * `/orgs/{orgId}/channels` (PLAN.md §10). Owner and Admin only. A channel's destination is a
 * credential (a Slack URL), so answers carry the origin only, and a webhook's signing secret
 * is in the answer to the request that made it and never again.
 */
@ApiTags('alerts')
@Controller('orgs/:orgId/channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly access: OrgAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List notification channels (Owner/Admin)' })
  async list(@CurrentUser() user: AuthenticatedUser, @Param('orgId') orgId: string) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return { channels: await this.channels.list(id) };
  }

  @Post()
  @ApiOperation({
    summary: 'Create a channel (Owner/Admin); a webhook’s signing secret is returned once',
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    const created = await this.channels.create(id, parseBody(createChannelSchema, body));
    setAuditContext(request, { targetType: 'channel', targetId: created.id });
    return created;
  }

  @Patch(':channelId')
  @ApiOperation({ summary: 'Change a channel, or make a webhook a new secret (Owner/Admin)' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('channelId') channelId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    setAuditContext(request, { targetType: 'channel', targetId: channelId });
    return this.channels.update(
      id,
      parseBody(orgIdParam, channelId),
      parseBody(updateChannelSchema, body),
    );
  }

  @Delete(':channelId')
  @RequiresSudo()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a channel and remove it from rules (Owner/Admin, sudo required)',
  })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('channelId') channelId: string,
    @Req() request: Request,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    setAuditContext(request, { targetType: 'channel', targetId: channelId });
    await this.channels.remove(id, parseBody(orgIdParam, channelId));
  }

  @Post(':channelId/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a test message through a channel (Owner/Admin); one attempt' })
  async test(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('channelId') channelId: string,
    @Req() request: Request,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    setAuditContext(request, { targetType: 'channel', targetId: channelId });
    return this.channels.test(id, parseBody(orgIdParam, channelId));
  }
}
