import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AllowsApiToken } from '../tokens/api-token.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { OrgAccessService } from '../orgs/org-access.service';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { createClusterSchema, reissueSchema, updateClusterSchema } from './clusters.dto';
import { ClustersService } from './clusters.service';

/**
 * `/orgs/{orgId}/clusters` (PLAN.md §10).
 *
 * Creating a cluster is an org-level act (Owner/Admin). Everything on an
 * existing cluster goes through the RBAC guard: `cluster:read` to see it,
 * `cluster:manage` to change it. Operations that mint or revoke credentials
 * additionally need a recent re-authentication.
 */
@ApiTags('clusters')
@Controller('orgs/:orgId/clusters')
export class ClustersController {
  constructor(
    private readonly clusters: ClustersService,
    private readonly access: OrgAccessService,
  ) {}

  @Get()
  @AllowsApiToken()
  @ApiOperation({ summary: 'List the clusters you can see' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Req() request: Request,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id);
    return { clusters: await this.clusters.list(id, user.id, request.apiToken) };
  }

  @Post()
  @RequiresSudo()
  @ApiOperation({
    summary: 'Add a cluster (Owner/Admin, sudo)',
    description:
      'Returns a one-time bootstrap token and the install command. The token is shown once.',
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: unknown,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    return this.clusters.create(id, parseBody(createClusterSchema, body));
  }

  @Get(':clusterId')
  @RequirePermission('cluster:read')
  @ApiOperation({ summary: 'Get one cluster' })
  get(@Param('orgId') orgId: string, @Param('clusterId') clusterId: string) {
    return this.clusters.get(parseBody(orgIdParam, orgId), parseBody(orgIdParam, clusterId));
  }

  @Patch(':clusterId')
  @RequirePermission('cluster:manage')
  @ApiOperation({ summary: 'Rename a cluster or change its labels' })
  update(
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
  ) {
    return this.clusters.update(
      parseBody(orgIdParam, orgId),
      parseBody(orgIdParam, clusterId),
      parseBody(updateClusterSchema, body),
    );
  }

  @Delete(':clusterId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('cluster:manage')
  @RequiresSudo()
  @ApiOperation({ summary: 'Delete a cluster and lock its agent out (sudo)' })
  async remove(
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
  ): Promise<void> {
    await this.clusters.remove(parseBody(orgIdParam, orgId), parseBody(orgIdParam, clusterId));
  }

  @Post(':clusterId/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cluster:manage')
  @RequiresSudo()
  @ApiOperation({ summary: 'Disable a cluster: revoke its certificates (sudo)' })
  disable(@Param('orgId') orgId: string, @Param('clusterId') clusterId: string) {
    return this.clusters.disable(parseBody(orgIdParam, orgId), parseBody(orgIdParam, clusterId));
  }

  @Post(':clusterId/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cluster:manage')
  @RequiresSudo()
  @ApiOperation({ summary: 'Re-enable a disabled cluster and issue a new token (sudo)' })
  enable(@Param('orgId') orgId: string, @Param('clusterId') clusterId: string) {
    return this.clusters.enable(parseBody(orgIdParam, orgId), parseBody(orgIdParam, clusterId));
  }

  @Post(':clusterId/bootstrap-token')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cluster:manage')
  @RequiresSudo()
  @ApiOperation({
    summary: 'Issue a new bootstrap token (sudo)',
    description: 'Invalidates any earlier unused token. Existing certificates are untouched.',
  })
  reissue(
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Body() body: unknown,
  ) {
    return this.clusters.reissueToken(
      parseBody(orgIdParam, orgId),
      parseBody(orgIdParam, clusterId),
      parseBody(reissueSchema, body ?? {}),
    );
  }

  @Post(':clusterId/rotate-certificate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cluster:manage')
  @RequiresSudo()
  @ApiOperation({
    summary: 'Revoke the agent’s certificates and require it to enrol again (sudo)',
  })
  rotate(@Param('orgId') orgId: string, @Param('clusterId') clusterId: string) {
    return this.clusters.rotateCertificate(
      parseBody(orgIdParam, orgId),
      parseBody(orgIdParam, clusterId),
    );
  }
}
