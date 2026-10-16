import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseBody } from '../common/parse-body';
import { OrgAccessService } from '../orgs/org-access.service';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AllowsApiToken } from '../tokens/api-token.decorator';
import { FleetService } from './fleet.service';

/** The fleet overview and a cluster's overview (PLAN.md §11.1). */
@ApiTags('inventory')
@Controller('orgs/:orgId')
export class FleetController {
  constructor(
    private readonly fleet: FleetService,
    private readonly access: OrgAccessService,
  ) {}

  @Get('fleet')
  @AllowsApiToken()
  @ApiOperation({
    summary: 'Every cluster you can see, with backup, schedule and storage health',
    description: 'A section you may not read is null, not zero.',
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Req() request: Request,
  ) {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    await this.access.require(user.id, orgId);
    return { clusters: await this.fleet.fleet(orgId, user.id, request.apiToken) };
  }

  @Get('clusters/:clusterId/overview')
  @AllowsApiToken()
  @RequirePermission('cluster:read')
  @ApiOperation({
    summary: 'Health, versions, policy, storage locations and recent activity of one cluster',
  })
  overview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Param('clusterId') clusterIdRaw: string,
    @Req() request: Request,
  ) {
    return this.fleet.overview(
      parseBody(orgIdParam, orgIdRaw),
      user.id,
      parseBody(orgIdParam, clusterIdRaw),
      request.apiToken,
    );
  }
}
