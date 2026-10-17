import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';

import { setAuditContext } from '../audit/audit.middleware';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { OrgAccessService } from '../orgs/org-access.service';
import { orgIdParam } from '../orgs/orgs.dto';
import { ApprovalsService } from './approvals.service';

const listQuery = z.object({ status: z.enum(['pending', 'decided']).default('pending') }).strict();
const rejectBody = z.object({ note: z.string().trim().max(500).optional() }).strict();

/**
 * `/orgs/{orgId}/approvals` (PLAN.md §10). Any member may look; what they see is the requests
 * they made and those they could decide. Approving needs a recent re-authentication, as
 * creating the restore does, and so is closed to API tokens.
 */
@ApiTags('approvals')
@Controller('orgs/:orgId/approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly access: OrgAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Restore requests waiting for approval, or decided in the last 30 days',
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Query() raw: unknown,
  ) {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    await this.access.require(user.id, orgId);
    const q = parseBody(listQuery, raw);
    return { approvals: await this.approvals.list(orgId, user.id, q.status) };
  }

  @Get('count')
  @ApiOperation({ summary: 'How many waiting requests the caller may decide' })
  async count(@CurrentUser() user: AuthenticatedUser, @Param('orgId') orgIdRaw: string) {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    await this.access.require(user.id, orgId);
    return { waiting: await this.approvals.waitingFor(orgId, user.id) };
  }

  @Post(':commandId/approve')
  @HttpCode(HttpStatus.OK)
  @RequiresSudo()
  @ApiOperation({
    summary: 'Approve a restore request (someone other than its requester; sudo required)',
    description:
      'The approver needs `restore:create` over the namespaces the restore will write. The restore is queued and sent to the agent.',
  })
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Param('commandId') commandId: string,
    @Req() request: Request,
  ) {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    await this.access.require(user.id, orgId);
    const id = parseBody(orgIdParam, commandId);
    setAuditContext(request, { targetType: 'restore_request', targetId: id });
    return this.approvals.approve(orgId, user.id, id);
  }

  @Post(':commandId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a restore request (someone other than its requester)',
  })
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Param('commandId') commandId: string,
    @Body() raw: unknown,
    @Req() request: Request,
  ) {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    await this.access.require(user.id, orgId);
    const id = parseBody(orgIdParam, commandId);
    const body = parseBody(rejectBody, raw ?? {});
    setAuditContext(request, { targetType: 'restore_request', targetId: id });
    return this.approvals.reject(orgId, user.id, id, body.note ?? null);
  }
}
