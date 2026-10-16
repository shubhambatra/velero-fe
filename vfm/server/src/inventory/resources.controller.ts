import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AllowsApiToken } from '../tokens/api-token.decorator';
import {
  DEFAULT_PAGE,
  MAX_PAGE,
  ResourcesService,
  type ListKind,
  type ListQuery,
} from './resources.service';

const csv = z
  .string()
  .max(300)
  .transform((value) =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== ''),
  )
  .pipe(z.array(z.string().max(64)).min(1).max(12));

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

const listQuery = z.object({
  phase: csv.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.string().max(32).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
  cursor: z.string().max(512).optional(),
  schedule: z.string().max(253).optional(),
  location: z.string().max(253).optional(),
  backup: z.string().max(253).optional(),
  paused: flag.optional(),
  createdByVfm: flag.optional(),
});

const nameParam = z
  .string()
  .regex(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/)
  .max(253);

type Raw = z.infer<typeof listQuery>;
const compact = (raw: Raw): ListQuery => {
  const out: ListQuery = { limit: raw.limit };
  for (const key of [
    'phase',
    'q',
    'sort',
    'order',
    'cursor',
    'schedule',
    'location',
    'backup',
    'paused',
    'createdByVfm',
  ] as const) {
    if (raw[key] !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = raw[key];
    }
  }
  return out;
};

/**
 * `/orgs/{orgId}/clusters/{id}/{backups|restores|schedules|backup-locations|
 * snapshot-locations|repositories}` (PLAN.md §10). Lists take documented filters and
 * sorts and a cursor (page size at most 200); an unknown sort or a filter the list
 * does not support is a 400, not silently ignored.
 *
 * Backups, restores and schedules are filtered by what the caller may see in their
 * namespaces (ADR-024); storage is cluster-level.
 */
@ApiTags('inventory')
@Controller('orgs/:orgId/clusters/:clusterId')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  private list(
    user: AuthenticatedUser,
    orgId: string,
    clusterId: string,
    kind: ListKind,
    query: unknown,
    request: Request,
  ) {
    return this.resources.list(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      kind,
      compact(parseBody(listQuery, query)),
      request.apiToken,
    );
  }

  @Get('backups')
  @AllowsApiToken()
  @RequirePermission('backup:read', { checkInHandler: true })
  @ApiOperation({
    summary: 'Backups you may see',
    description:
      'Filters: phase (comma list), q, schedule, location, createdByVfm. Sorts: startedAt, completedAt, expiresAt, name, phase.',
  })
  backups(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Query() q: unknown,
    @Req() r: Request,
  ) {
    return this.list(u, o, c, 'BACKUP', q, r);
  }

  @Get('restores')
  @AllowsApiToken()
  @RequirePermission('restore:read', { checkInHandler: true })
  @ApiOperation({
    summary: 'Restores you may see',
    description:
      'Filters: phase, q, backup, schedule, createdByVfm. Sorts: startedAt, completedAt, name, phase.',
  })
  restores(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Query() q: unknown,
    @Req() r: Request,
  ) {
    return this.list(u, o, c, 'RESTORE', q, r);
  }

  @Get('schedules')
  @AllowsApiToken()
  @RequirePermission('schedule:read', { checkInHandler: true })
  @ApiOperation({
    summary: 'Schedules you may see',
    description: 'Filters: phase, q, paused, createdByVfm. Sorts: name, phase.',
  })
  schedules(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Query() q: unknown,
    @Req() r: Request,
  ) {
    return this.list(u, o, c, 'SCHEDULE', q, r);
  }

  @Get('backup-locations')
  @AllowsApiToken()
  @RequirePermission('storage:read')
  @ApiOperation({ summary: 'Backup storage locations' })
  backupLocations(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Query() q: unknown,
    @Req() r: Request,
  ) {
    return this.list(u, o, c, 'BACKUP_STORAGE_LOCATION', q, r);
  }

  @Get('snapshot-locations')
  @AllowsApiToken()
  @RequirePermission('storage:read')
  @ApiOperation({ summary: 'Volume snapshot locations' })
  snapshotLocations(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Query() q: unknown,
    @Req() r: Request,
  ) {
    return this.list(u, o, c, 'VOLUME_SNAPSHOT_LOCATION', q, r);
  }

  @Get('repositories')
  @AllowsApiToken()
  @RequirePermission('storage:read')
  @ApiOperation({ summary: 'Backup repositories' })
  repositories(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Query() q: unknown,
    @Req() r: Request,
  ) {
    return this.list(u, o, c, 'BACKUP_REPOSITORY', q, r);
  }

  @Get('backups/:name')
  @AllowsApiToken()
  @RequirePermission('backup:read', { checkInHandler: true })
  @ApiOperation({
    summary:
      'One backup: summary, timeline, spec, status, YAML and its volumes. 404 if you may not see it.',
  })
  backup(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Req() r: Request,
  ) {
    return this.resources.detail(
      parseBody(orgIdParam, o),
      u.id,
      parseBody(orgIdParam, c),
      'BACKUP',
      parseBody(nameParam, n),
      r.apiToken,
    );
  }

  @Get('restores/:name')
  @AllowsApiToken()
  @RequirePermission('restore:read', { checkInHandler: true })
  @ApiOperation({
    summary: 'One restore: summary, timeline, spec, status and YAML. 404 if you may not see it.',
  })
  restore(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Req() r: Request,
  ) {
    return this.resources.detail(
      parseBody(orgIdParam, o),
      u.id,
      parseBody(orgIdParam, c),
      'RESTORE',
      parseBody(nameParam, n),
      r.apiToken,
    );
  }

  @Get('schedules/:name')
  @AllowsApiToken()
  @RequirePermission('schedule:read', { checkInHandler: true })
  @ApiOperation({
    summary: 'One schedule: summary, spec, status and YAML. 404 if you may not see it.',
  })
  schedule(
    @CurrentUser() u: AuthenticatedUser,
    @Param('orgId') o: string,
    @Param('clusterId') c: string,
    @Param('name') n: string,
    @Req() r: Request,
  ) {
    return this.resources.detail(
      parseBody(orgIdParam, o),
      u.id,
      parseBody(orgIdParam, c),
      'SCHEDULE',
      parseBody(nameParam, n),
      r.apiToken,
    );
  }
}
