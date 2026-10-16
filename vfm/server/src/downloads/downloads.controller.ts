import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AllowsApiToken } from '../tokens/api-token.decorator';
import { DownloadsService } from './downloads.service';
import type { ObjectKind } from './parts';

const nameParam = z
  .string()
  .regex(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/)
  .max(253);
const slugParam = z.string().regex(/^[a-z-]{3,32}$/);
const flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const fetchQuery = z.object({ refresh: flag.optional(), download: flag.optional() });

/**
 * Velero's own files for a backup or restore (PLAN.md §7.3, §10): logs, and the
 * "describe --details" parts. `POST` asks the agent to fetch a file (202 with the
 * command to follow, or 200 when a fresh copy is already held); `GET` serves the
 * held copy as text (204 when none is held).
 *
 * Logs need `backup:logs` / `restore:logs`; the detail parts need the kind's `read`
 * permission. A POST is audited like any mutating call.
 */
@ApiTags('downloads')
@Controller('orgs/:orgId/clusters/:clusterId')
export class DownloadsController {
  constructor(private readonly downloads: DownloadsService) {}

  private async fetch(
    user: AuthenticatedUser,
    orgId: string,
    clusterId: string,
    kind: ObjectKind,
    name: string,
    slug: string,
    query: unknown,
    request: Request,
    response: Response,
  ) {
    const result = await this.downloads.request(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      kind,
      parseBody(nameParam, name),
      parseBody(slugParam, slug),
      parseBody(fetchQuery, query).refresh === true,
      request.apiToken,
    );
    response.status(result.state === 'cached' ? HttpStatus.OK : HttpStatus.ACCEPTED);
    return result;
  }

  private async serve(
    user: AuthenticatedUser,
    orgId: string,
    clusterId: string,
    kind: ObjectKind,
    name: string,
    slug: string,
    query: unknown,
    request: Request,
    response: Response,
  ) {
    const {
      file,
      part,
      name: target,
    } = await this.downloads.read(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      kind,
      parseBody(nameParam, name),
      parseBody(slugParam, slug),
      request.apiToken,
    );
    if (file === null) {
      response.status(HttpStatus.NO_CONTENT).setHeader('X-Vfm-Cache', 'miss');
      return undefined;
    }
    const wantsDownload = parseBody(fetchQuery, query).download === true;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    // Files name resources and are never meant to be rendered or cached by anything else.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Vfm-Cache', 'hit');
    response.setHeader('X-Vfm-Fetched-At', file.fetchedAt.toISOString());
    response.setHeader('X-Vfm-Expires-At', file.expiresAt.toISOString());
    if (wantsDownload) {
      response.setHeader(
        'Content-Disposition',
        `attachment; filename="${target}-${part.slug.replace('/', '-')}.txt"`,
      );
    }
    return new StreamableFile(file.data);
  }

  // --- backups -------------------------------------------------------------

  @Post('backups/:name/logs')
  @AllowsApiToken()
  @RequirePermission('backup:logs', { checkInHandler: true })
  @ApiOperation({ summary: 'Fetch a backup’s log from the cluster (or report a fresh copy)' })
  fetchBackupLog(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Query() q: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.fetch(u, o, c, 'BACKUP', n, 'logs', q, req, res);
  }

  @Get('backups/:name/logs')
  @AllowsApiToken()
  @RequirePermission('backup:logs', { checkInHandler: true })
  @ApiOperation({ summary: 'A backup’s log, as text; 204 when none is held' })
  backupLog(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Query() q: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.serve(u, o, c, 'BACKUP', n, 'logs', q, req, res);
  }

  @Post('backups/:name/details/:part')
  @AllowsApiToken()
  @RequirePermission('backup:read', { checkInHandler: true })
  @ApiOperation({ summary: 'Fetch a detail file of a backup (results, resource-list, ...)' })
  fetchBackupDetail(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Param('part') p: string,
    @Query() q: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.fetch(u, o, c, 'BACKUP', n, this.detail(p), q, req, res);
  }

  @Get('backups/:name/details/:part')
  @AllowsApiToken()
  @RequirePermission('backup:read', { checkInHandler: true })
  @ApiOperation({ summary: 'A detail file of a backup; 204 when none is held' })
  backupDetail(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Param('part') p: string,
    @Query() q: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.serve(u, o, c, 'BACKUP', n, this.detail(p), q, req, res);
  }

  // --- restores ------------------------------------------------------------

  @Post('restores/:name/logs')
  @AllowsApiToken()
  @RequirePermission('restore:logs', { checkInHandler: true })
  @ApiOperation({ summary: 'Fetch a restore’s log from the cluster (or report a fresh copy)' })
  fetchRestoreLog(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Query() q: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.fetch(u, o, c, 'RESTORE', n, 'logs', q, req, res);
  }

  @Get('restores/:name/logs')
  @AllowsApiToken()
  @RequirePermission('restore:logs', { checkInHandler: true })
  @ApiOperation({ summary: 'A restore’s log, as text; 204 when none is held' })
  restoreLog(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Query() q: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.serve(u, o, c, 'RESTORE', n, 'logs', q, req, res);
  }

  @Post('restores/:name/details/:part')
  @AllowsApiToken()
  @RequirePermission('restore:read', { checkInHandler: true })
  @ApiOperation({ summary: 'Fetch a detail file of a restore (results, resource-list, ...)' })
  fetchRestoreDetail(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Param('part') p: string,
    @Query() q: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.fetch(u, o, c, 'RESTORE', n, this.detail(p), q, req, res);
  }

  @Get('restores/:name/details/:part')
  @AllowsApiToken()
  @RequirePermission('restore:read', { checkInHandler: true })
  @ApiOperation({ summary: 'A detail file of a restore; 204 when none is held' })
  restoreDetail(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Param('part') p: string,
    @Query() q: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.serve(u, o, c, 'RESTORE', n, this.detail(p), q, req, res);
  }

  /**
   * A detail route must not reach the log, which needs a different permission:
   * `details/logs` would otherwise be a way around `backup:logs`.
   */
  private detail(slug: string): string {
    return slug === 'logs' ? 'not-a-detail' : slug;
  }
}
