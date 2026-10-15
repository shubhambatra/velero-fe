import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { createRoleBindingSchema, orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from './require-permission.decorator';
import { RoleBindingsService } from './role-bindings.service';

/**
 * `/clusters/{clusterId}/role-bindings` (PLAN.md §10). Acts in the session's
 * active org. Managing bindings needs `cluster:manage` and, being hard to
 * notice and easy to abuse, recent re-authentication (§8.3 sudo mode).
 */
@ApiTags('rbac')
@Controller('clusters/:clusterId')
export class RoleBindingsController {
  constructor(private readonly bindings: RoleBindingsService) {}

  private orgOf(request: Request): string {
    // The guard has already refused a missing or malformed active org.
    return request.session?.activeOrgId ?? '';
  }

  @Get('my-access')
  @RequirePermission('cluster:read')
  @ApiOperation({ summary: 'What the caller may do on this cluster' })
  async myAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('clusterId') clusterId: string,
  ) {
    return this.bindings.myAccess(this.orgOf(request), user.id, parseBody(orgIdParam, clusterId));
  }

  @Get('role-bindings')
  @RequirePermission('cluster:manage')
  @ApiOperation({ summary: 'List role bindings (cluster:manage)' })
  async list(@Req() request: Request, @Param('clusterId') clusterId: string) {
    return {
      bindings: await this.bindings.list(this.orgOf(request), parseBody(orgIdParam, clusterId)),
    };
  }

  @Post('role-bindings')
  @RequirePermission('cluster:manage')
  @RequiresSudo()
  @ApiOperation({ summary: 'Grant a role (cluster:manage, sudo)' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
  ) {
    return this.bindings.create(
      this.orgOf(request),
      parseBody(orgIdParam, clusterId),
      user.id,
      parseBody(createRoleBindingSchema, body),
    );
  }

  @Delete('role-bindings/:bindingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('cluster:manage')
  @RequiresSudo()
  @ApiOperation({ summary: 'Revoke a role binding (cluster:manage, sudo)' })
  async remove(
    @Req() request: Request,
    @Param('clusterId') clusterId: string,
    @Param('bindingId') bindingId: string,
  ): Promise<void> {
    await this.bindings.remove(
      this.orgOf(request),
      parseBody(orgIdParam, clusterId),
      parseBody(orgIdParam, bindingId),
    );
  }
}
