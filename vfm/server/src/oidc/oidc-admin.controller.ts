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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { OrgAccessService } from '../orgs/org-access.service';
import { orgIdParam } from '../orgs/orgs.dto';
import { createProviderSchema, updateProviderSchema } from './oidc.dto';
import { OidcProvidersService } from './oidc-providers.service';

/** `/orgs/{orgId}/oidc-providers` (PLAN.md §10). Owner/Admin only. */
@ApiTags('oidc')
@Controller('orgs/:orgId/oidc-providers')
export class OidcAdminController {
  constructor(
    private readonly providers: OidcProvidersService,
    private readonly access: OrgAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List OIDC providers (Owner/Admin). The secret is never returned.' })
  async list(@CurrentUser() user: AuthenticatedUser, @Param('orgId') orgId: string) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return { providers: await this.providers.list(id) };
  }

  @Post()
  @ApiOperation({ summary: 'Add an OIDC provider (Owner/Admin)' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return this.providers.create(id, parseBody(createProviderSchema, body));
  }

  @Patch(':providerId')
  @ApiOperation({ summary: 'Update an OIDC provider (Owner/Admin)' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('providerId') providerId: string,
    @Body() body: unknown,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return this.providers.update(
      id,
      parseBody(orgIdParam, providerId),
      parseBody(updateProviderSchema, body),
    );
  }

  @Delete(':providerId')
  @RequiresSudo()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an OIDC provider (Owner/Admin, sudo required)' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('providerId') providerId: string,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    await this.providers.remove(id, parseBody(orgIdParam, providerId));
  }
}
