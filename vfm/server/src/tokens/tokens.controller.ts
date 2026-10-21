import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { OrgAccessService } from '../orgs/org-access.service';
import { orgIdParam } from '../orgs/orgs.dto';
import { ApiTokensService } from './api-tokens.service';

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  permissions: z.array(z.string().min(1).max(64)).max(64).optional(),
  clusterIds: z.array(z.uuid()).max(500).optional(),
  // Optional per §8.3, but capped: a token that never expires is a decision,
  // so it is made by leaving the field out, not by typing a huge number.
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const listSchema = z.object({ scope: z.enum(['own', 'org']).default('own') });

/**
 * `/orgs/{orgId}/tokens` (PLAN.md §10 `/me/tokens`, §11 screen 9).
 *
 * Token management needs a browser session: it is deliberately not marked
 * `@AllowsApiToken()`, so a leaked token cannot mint or enumerate more.
 */
@ApiTags('tokens')
@Controller('orgs/:orgId/tokens')
export class TokensController {
  constructor(
    private readonly tokens: ApiTokensService,
    private readonly access: OrgAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List tokens: your own, or the whole org with ?scope=org (Owner/Admin)',
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Query() query: unknown,
  ) {
    const id = parseBody(orgIdParam, orgId);
    const { scope } = parseBody(listSchema, query);
    await this.access.require(user.id, id, scope === 'org' ? 'ADMIN' : 'MEMBER');
    return { tokens: await this.tokens.list(id, user.id, scope) };
  }

  @Post()
  @RequiresSudo()
  @ApiOperation({
    summary: 'Create a token (sudo)',
    description:
      'The secret is returned once and never again. A token acts as its owner and can only narrow, never widen, what the owner holds.',
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id);
    if (request.apiToken !== undefined) {
      throw new ForbiddenException('tokens cannot create tokens');
    }
    return this.tokens.create(id, user.id, parseBody(createSchema, body));
  }

  @Delete(':tokenId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a token (own, or any as Owner/Admin)' })
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('tokenId') tokenId: string,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    const membership = await this.access.require(user.id, id);
    await this.tokens.revoke(
      id,
      parseBody(orgIdParam, tokenId),
      user.id,
      membership.orgRole === 'MEMBER',
    );
  }
}
