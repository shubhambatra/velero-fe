import { Body, Controller, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { RequiresSudo } from '../auth/sudo.guard';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AllowsApiToken } from '../tokens/api-token.decorator';
import { ApprovalPolicyService } from './approval-policy.service';

const body = z.object({ required: z.boolean() }).strict();

/**
 * Whether restores on one cluster need approval (PLAN.md §8.4). Reading is for anyone who can
 * see the cluster, so the restore wizard can say so before the request is made. Changing it
 * needs `cluster:manage` and a recent re-authentication, because turning it off removes a
 * safeguard. The org-wide setting is separate (`PATCH /orgs/{orgId}`) and cannot be undone here.
 */
@ApiTags('approvals')
@Controller('orgs/:orgId/clusters/:clusterId/restore-approval')
export class ClusterApprovalController {
  constructor(private readonly policy: ApprovalPolicyService) {}

  @Get()
  @AllowsApiToken()
  @RequirePermission('cluster:read')
  @ApiOperation({ summary: 'Whether restores on this cluster need approval, and why' })
  get(@Param('orgId') orgId: string, @Param('clusterId') clusterId: string) {
    return this.policy.forCluster(parseBody(orgIdParam, orgId), parseBody(orgIdParam, clusterId));
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @RequiresSudo()
  @RequirePermission('cluster:manage')
  @ApiOperation({ summary: 'Ask for approval of restores on this cluster, or stop asking (sudo)' })
  put(@Param('orgId') orgId: string, @Param('clusterId') clusterId: string, @Body() raw: unknown) {
    return this.policy.setForCluster(
      parseBody(orgIdParam, orgId),
      parseBody(orgIdParam, clusterId),
      parseBody(body, raw).required,
    );
  }
}
