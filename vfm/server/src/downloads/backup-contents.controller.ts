import { Controller, Header, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { RateLimit } from '../common/rate-limit';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AllowsApiToken } from '../tokens/api-token.decorator';
import { BackupContentsService, type BackupLink } from './backup-contents.service';
import { z } from 'zod';

const nameParam = z
  .string()
  .regex(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/)
  .max(253);

/**
 * `POST /orgs/{orgId}/clusters/{clusterId}/backups/{name}/download-url` (PLAN.md section 10). A POST, not a GET, because
 * it has an effect (a request to the cluster, an audit event) and must carry the CSRF token. The answer is a
 * credential, so it is never cacheable.
 */
@ApiTags('downloads')
@Controller('orgs/:orgId/clusters/:clusterId')
export class BackupContentsController {
  constructor(private readonly contents: BackupContentsService) {}

  @Post('backups/:name/download-url')
  @HttpCode(HttpStatus.OK)
  @AllowsApiToken()
  @RequirePermission('backup:download', { checkInHandler: true })
  @RequiresSudo()
  @RateLimit('backup-download', 10, 60)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A short-lived signed link to a backup’s contents (backup:download, sudo)',
    description:
      'Backup data is not proxied: this returns a presigned URL to the object storage, valid for a few minutes. ' +
      'Refused unless the organization allows backup downloads (off by default) and the caller holds `backup:download` over every namespace in the backup.',
  })
  @ApiResponse({ status: 200, description: '`{ url, expiresAt }`.' })
  @ApiResponse({
    status: 403,
    description: 'Downloads are off for the organization, or not permitted.',
  })
  @ApiResponse({ status: 404, description: 'No such backup, or not one the caller may download.' })
  @ApiResponse({
    status: 409,
    description: 'The backup has no contents (not Completed or PartiallyFailed).',
  })
  @ApiResponse({ status: 504, description: 'The agent did not answer in time.' })
  link(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('name') name: string,
    @Req() request: Request,
  ): Promise<BackupLink> {
    return this.contents.link(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(nameParam, name),
      {
        ip: request.ip,
        userAgent: request.get('user-agent'),
        requestId: request.get('x-request-id'),
      },
      request.apiToken,
    );
  }
}
