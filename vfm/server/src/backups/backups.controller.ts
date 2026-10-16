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
import { BackupsService } from './backups.service';

const nameParam = z
  .string()
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
  .max(63);

/**
 * Backup operations (PLAN.md §10). Each returns `202` with the command to follow:
 * the agent may be offline, slow, or refuse by its own policy, so a backup is never
 * reported as made by this response.
 *
 * The route guard only checks that the caller could possibly do this; the namespaces
 * it reaches are checked in the service.
 */
@ApiTags('backups')
@Controller('orgs/:orgId/clusters/:clusterId')
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Post('backups')
  @HttpCode(HttpStatus.ACCEPTED)
  @AllowsApiToken()
  @RequirePermission('backup:create', { checkInHandler: true })
  @ApiOperation({
    summary: 'Create a backup (velero backup create)',
    description:
      'A user with a namespace-scoped binding must name every namespace and set `includeClusterResources: false`. `advancedSpec` needs `advanced:write`. Returns 202 with the command; follow it, and the backup appears in the inventory.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.backups.create(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      body,
      request.apiToken,
    );
  }

  @Delete('backups/:name')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('backup:delete', { checkInHandler: true })
  @ApiOperation({
    summary: 'Delete a backup and its data (velero backup delete)',
    description:
      'Needs recent re-authentication. Velero removes the backup, its files in object storage and its snapshots through a DeleteBackupRequest.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Req() request: Request,
  ) {
    return this.backups.delete(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(nameParam, name),
      request.apiToken,
    );
  }

  @Post('schedules/:name/trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  @AllowsApiToken()
  @RequirePermission('backup:create', { checkInHandler: true })
  @ApiOperation({
    summary: 'Run a schedule now (velero backup create --from-schedule)',
    description:
      'Makes a backup from the schedule’s template. The caller needs `backup:create` over everything the template covers.',
  })
  trigger(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.backups.trigger(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(nameParam, name),
      body,
      request.apiToken,
    );
  }
}
