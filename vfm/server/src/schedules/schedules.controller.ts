import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
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
import { SchedulesService } from './schedules.service';

const nameParam = z
  .string()
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
  .max(63);

/**
 * Schedule operations (PLAN.md §10). Each returns `202` with the command to follow.
 * Run-now is `POST …/schedules/{name}/trigger` in the backups module.
 */
@ApiTags('schedules')
@Controller('orgs/:orgId/clusters/:clusterId/schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @AllowsApiToken()
  @RequirePermission('schedule:write', { checkInHandler: true })
  @ApiOperation({
    summary: 'Create a schedule (velero schedule create)',
    description:
      'The template takes the fields of a backup. A user with a namespace-scoped binding must name every namespace and set `template.includeClusterResources: false`. `advancedSpec` needs `advanced:write`.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.schedules.create(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      body,
      request.apiToken,
    );
  }

  @Put(':name')
  @HttpCode(HttpStatus.ACCEPTED)
  @AllowsApiToken()
  @RequirePermission('schedule:write', { checkInHandler: true })
  @ApiOperation({
    summary: 'Replace a schedule’s spec',
    description:
      'The whole spec is replaced by the body. Hooks already on the template stay unless `advancedSpec` sets them.',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.schedules.update(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(nameParam, name),
      body,
      request.apiToken,
    );
  }

  @Post(':name/pause')
  @HttpCode(HttpStatus.ACCEPTED)
  @AllowsApiToken()
  @RequirePermission('schedule:write', { checkInHandler: true })
  @ApiOperation({
    summary: 'Pause or resume a schedule (velero schedule pause / unpause)',
    description: 'Body: `{ "paused": true }` or `{ "paused": false }`.',
  })
  setPaused(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.schedules.setPaused(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(nameParam, name),
      body,
      request.apiToken,
    );
  }

  @Delete(':name')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('schedule:delete', { checkInHandler: true })
  @ApiOperation({
    summary: 'Delete a schedule (velero schedule delete)',
    description: 'Needs recent re-authentication. The backups the schedule made stay.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Req() request: Request,
  ) {
    return this.schedules.delete(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(nameParam, name),
      request.apiToken,
    );
  }
}
