import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AllowsApiToken } from '../tokens/api-token.decorator';
import { RestoresService } from './restores.service';

const nameParam = z
  .string()
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
  .max(63);

/**
 * Restore operations (PLAN.md §10). Both need a recent re-authentication, so neither is
 * open to an API token (PLAN.md §8.3), and each returns `202` with the command to follow.
 */
@ApiTags('restores')
@Controller('orgs/:orgId/clusters/:clusterId')
export class RestoresController {
  constructor(private readonly restores: RestoresService) {}

  @Post('restores')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('restore:create', { checkInHandler: true })
  @ApiOperation({
    summary: 'Restore from a backup or a schedule (velero restore create)',
    description:
      'Needs recent re-authentication. The caller needs `restore:create` over every namespace the restore reads and writes, after namespace mapping; a user with a namespace-scoped binding must name them all and send `includeClusterResources: false`. `advancedSpec` needs `advanced:write`.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.restores.create(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      body,
      request.apiToken,
    );
  }

  @Post('restores/impact')
  @HttpCode(HttpStatus.ACCEPTED)
  @AllowsApiToken()
  @RequirePermission('restore:create', { checkInHandler: true })
  @ApiOperation({
    summary: 'Which of these namespaces exist now (the restore wizard’s impact summary)',
    description:
      'The caller needs `restore:create` over every namespace named. Returns 202 with the command; its result lists, for each name asked about, whether the namespace exists.',
  })
  impact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.restores.impact(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      body,
      request.apiToken,
    );
  }

  @Delete('restores/:name')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('restore:delete', { checkInHandler: true })
  @ApiOperation({
    summary: 'Delete a restore (velero restore delete)',
    description: 'Needs recent re-authentication. The restored resources stay where they are.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Req() request: Request,
  ) {
    return this.restores.delete(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(nameParam, name),
      request.apiToken,
    );
  }
}
