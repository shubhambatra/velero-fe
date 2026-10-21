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

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { locationName } from './location-request';
import { StorageService } from './storage.service';

const CREDENTIAL_NOTE =
  'A `credential` with `content` is written by the agent to a Secret and is never stored by the control plane. A `credential` with only `secretName` and `key` points at a Secret that already exists.';

/**
 * Storage location operations (PLAN.md §10). Each returns `202` with the command to
 * follow. Reads are `GET …/backup-locations` and `GET …/snapshot-locations`.
 */
@ApiTags('storage')
@Controller('orgs/:orgId/clusters/:clusterId')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('backup-locations')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('storage:write')
  @ApiOperation({
    summary: 'Create a backup storage location (velero backup-location create)',
    description: CREDENTIAL_NOTE,
  })
  createBackupLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.storage.createBackupLocation(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      body,
      request.apiToken,
    );
  }

  @Put('backup-locations/:name')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('storage:write')
  @ApiOperation({
    summary: 'Replace a backup storage location’s spec',
    description: `${CREDENTIAL_NOTE} Leave \`credential\` out to keep the Secret the location uses now.`,
  })
  updateBackupLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.storage.updateBackupLocation(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(locationName, name),
      body,
      request.apiToken,
    );
  }

  @Post('backup-locations/:name/default')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('storage:write')
  @ApiOperation({
    summary: 'Make a backup storage location the default (velero backup-location set --default)',
  })
  setDefault(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Req() request: Request,
  ) {
    return this.storage.setDefault(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(locationName, name),
      request.apiToken,
    );
  }

  @Delete('backup-locations/:name')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('storage:write')
  @ApiOperation({
    summary: 'Delete a backup storage location (velero backup-location delete)',
    description:
      'Needs recent re-authentication. The bucket and the backups in it are not touched. The default location cannot be deleted while others exist.',
  })
  deleteBackupLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Req() request: Request,
  ) {
    return this.storage.deleteBackupLocation(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(locationName, name),
      request.apiToken,
    );
  }

  @Post('snapshot-locations')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('storage:write')
  @ApiOperation({
    summary: 'Create a volume snapshot location (velero snapshot-location create)',
    description: CREDENTIAL_NOTE,
  })
  createSnapshotLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.storage.createSnapshotLocation(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      body,
      request.apiToken,
    );
  }

  @Put('snapshot-locations/:name')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('storage:write')
  @ApiOperation({
    summary: 'Replace a volume snapshot location’s spec',
    description: `${CREDENTIAL_NOTE} Leave \`credential\` out to keep the Secret the location uses now.`,
  })
  updateSnapshotLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    return this.storage.updateSnapshotLocation(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(locationName, name),
      body,
      request.apiToken,
    );
  }

  @Delete('snapshot-locations/:name')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiresSudo()
  @RequirePermission('storage:write')
  @ApiOperation({
    summary: 'Delete a volume snapshot location (velero snapshot-location delete)',
    description: 'Needs recent re-authentication. Snapshots already taken are not touched.',
  })
  deleteSnapshotLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Req() request: Request,
  ) {
    return this.storage.deleteSnapshotLocation(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(locationName, name),
      request.apiToken,
    );
  }
}
