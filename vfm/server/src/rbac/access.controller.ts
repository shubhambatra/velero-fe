import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from './require-permission.decorator';
import { RbacService } from './rbac.service';
import { AllowsApiToken } from '../tokens/api-token.decorator';

/** The permissions the UI asks about, to show an action disabled with its reason. */
const ASKED = [
  'backup:create',
  'backup:delete',
  'backup:logs',
  'restore:create',
  'restore:delete',
  'restore:logs',
  'schedule:write',
  'schedule:delete',
  'storage:write',
  'advanced:write',
] as const;

@ApiTags('rbac')
@Controller('orgs/:orgId/clusters/:clusterId')
export class AccessController {
  constructor(private readonly rbac: RbacService) {}

  @Get('access')
  @AllowsApiToken()
  @RequirePermission('cluster:read')
  @ApiOperation({
    summary: 'What the caller may do on this cluster',
    description:
      'Per permission: `cluster` (everywhere), `scoped` (only in some namespaces) or `none`. A hint for the UI; each request is still authorized on its own.',
  })
  async access(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Req() request: Request,
  ) {
    return {
      access: await this.rbac.access(
        parseBody(orgIdParam, orgId),
        user.id,
        parseBody(orgIdParam, clusterId),
        ASKED,
        request.apiToken,
      ),
    };
  }
}
