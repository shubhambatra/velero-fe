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
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { setAuditContext } from '../audit/audit.middleware';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { OrgAccessService } from '../orgs/org-access.service';
import { orgIdParam } from '../orgs/orgs.dto';
import {
  AlertRulesService,
  createRuleSchema,
  listEventsQuery,
  updateRuleSchema,
} from './alert-rules.service';

/**
 * `/orgs/{orgId}/alerts` (PLAN.md §10). Owner and Admin only, for reads too: an event names
 * clusters, namespaces and backups across the whole org, which a cluster-scoped person is not
 * entitled to see.
 */
@ApiTags('alerts')
@Controller('orgs/:orgId/alerts')
export class AlertsController {
  constructor(
    private readonly rules: AlertRulesService,
    private readonly access: OrgAccessService,
  ) {}

  @Get('rules')
  @ApiOperation({ summary: 'List alert rules, with how many of each are firing (Owner/Admin)' })
  async list(@CurrentUser() user: AuthenticatedUser, @Param('orgId') orgId: string) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return { rules: await this.rules.list(id) };
  }

  @Post('rules')
  @ApiOperation({ summary: 'Create an alert rule (Owner/Admin)' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    const rule = await this.rules.create(id, parseBody(createRuleSchema, body));
    setAuditContext(request, { targetType: 'alert_rule', targetId: rule.id });
    return rule;
  }

  @Patch('rules/:ruleId')
  @ApiOperation({ summary: 'Change an alert rule (Owner/Admin)' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    setAuditContext(request, { targetType: 'alert_rule', targetId: ruleId });
    return this.rules.update(id, parseBody(orgIdParam, ruleId), parseBody(updateRuleSchema, body));
  }

  @Delete('rules/:ruleId')
  @RequiresSudo()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an alert rule and its history (Owner/Admin, sudo required)' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('ruleId') ruleId: string,
    @Req() request: Request,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    setAuditContext(request, { targetType: 'alert_rule', targetId: ruleId });
    await this.rules.remove(id, parseBody(orgIdParam, ruleId));
  }

  @Get('events')
  @ApiOperation({ summary: 'Alert history, newest first (Owner/Admin)' })
  async events(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Query() query: unknown,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return this.rules.events(id, parseBody(listEventsQuery, query));
  }
}
