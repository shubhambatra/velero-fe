import { RateLimit } from '../common/rate-limit';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { setAuditContext } from '../audit/audit.middleware';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { MfaService } from '../auth/mfa.service';
import { Public } from '../auth/public.decorator';
import { SessionCookiesService } from '../auth/session-cookies.service';
import { SessionService } from '../auth/session.service';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { InviteRejectedError, InvitesService } from './invites.service';
import { OrgAccessService } from './org-access.service';
import {
  acceptInviteSchema,
  createInviteSchema,
  orgIdParam,
  registerViaInviteSchema,
} from './orgs.dto';

/** Invitations (PLAN.md §16 day 6, §10 `/orgs/{orgId}` invites). */
@ApiTags('invites')
@Controller()
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly access: OrgAccessService,
    private readonly sessions: SessionService,
    private readonly cookies: SessionCookiesService,
    private readonly mfa: MfaService,
  ) {}

  @Post('orgs/:orgId/invites')
  @ApiOperation({
    summary: 'Invite someone by email (Owner/Admin)',
    description: 'Responds 503 if SMTP is not configured; no invitation is stored in that case.',
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
  ) {
    const id = parseBody(orgIdParam, orgId);
    const actor = await this.access.require(user.id, id, 'ADMIN');
    const input = parseBody(createInviteSchema, body);
    if (!OrgAccessService.canAssign(actor.orgRole, input.orgRole)) {
      throw new BadRequestException('only an owner may invite an owner');
    }
    return this.invites.create(id, user.id, input);
  }

  @Get('orgs/:orgId/invites')
  @ApiOperation({ summary: 'Pending invitations (Owner/Admin)' })
  async list(@CurrentUser() user: AuthenticatedUser, @Param('orgId') orgId: string) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return { invites: await this.invites.list(id) };
  }

  @Delete('orgs/:orgId/invites/:inviteId')
  @RequiresSudo()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an invitation (Owner/Admin, sudo required)' })
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    await this.invites.revoke(id, parseBody(orgIdParam, inviteId));
  }

  @Post('invites/accept')
  @ApiOperation({
    summary: 'Accept an invitation with an existing account',
    description:
      'The signed-in account must hold the invited address. Single use. Responds with the same 400 for an unknown, expired, used or foreign token.',
  })
  async accept(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const { token } = parseBody(acceptInviteSchema, body);
    try {
      return await this.invites.accept(token, user);
    } catch (error: unknown) {
      throw rejected(error);
    }
  }

  @RateLimit('invite-register', 20, 3600, 'ip')
  @Public()
  @Post('invites/register')
  @ApiOperation({
    summary: 'Accept an invitation by creating an account',
    description:
      'The only user-creation path after first-time setup. Requires a valid token for an address that has no account.',
  })
  async register(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parseBody(registerViaInviteSchema, body);
    let result;
    try {
      result = await this.invites.register(input.token, {
        password: input.password,
        name: input.name,
      });
    } catch (error: unknown) {
      throw rejected(error);
    }

    // A new Owner or Admin owes MFA immediately (PLAN.md §8.3).
    const obligation = await this.mfa.obligationFor(result.user.id);
    const created = await this.sessions.create({
      userId: result.user.id,
      ip: request.ip ?? request.socket.remoteAddress ?? 'unknown',
      userAgent: request.header('user-agent') ?? '',
      mfaPending: obligation.required,
      mfaPendingReason: obligation.required ? 'enrolment' : null,
    });
    this.cookies.issue(response, created);
    setAuditContext(request, { actorId: result.user.id, orgId: result.orgId });

    return {
      orgId: result.orgId,
      user: result.user,
      mfaPendingReason: obligation.required ? 'enrolment' : null,
    };
  }
}

/** One message for every way an invitation can be unusable. */
function rejected(error: unknown): unknown {
  if (error instanceof InviteRejectedError) {
    return new BadRequestException('invalid or expired invitation');
  }
  return error;
}
