import { Controller, Get, Param, Req } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from './require-permission.decorator';
import { RbacService } from './rbac.service';
import { AllowsApiToken } from '../tokens/api-token.decorator';

/** The permissions the UI asks about, to show an action disabled with its reason. */
const ASKED = [
  'backup:create',
  'backup:delete',
  'backup:logs',
  'restore:create',
  'restore:delete',
  'restore:logs',
  'schedule:write',
  'schedule:delete',
  'storage:write',
  'advanced:write',
  'logs:read',
] as const;

const READ_ONLY_ALLOWS: ReadonlySet<string> = new Set(['backup:logs', 'restore:logs', 'logs:read']);

/**
 * Permissions the cluster's own agent policy refuses, with the reason (PLAN.md §5.5, §12).
 * The agent enforces its policy itself; this only lets the UI say so instead of offering
 * an action that is bound to fail. An unknown or missing policy blocks nothing here.
 */
export function policyBlocks(policy: unknown): Record<string, string> {
  const p =
    typeof policy === 'object' && policy !== null ? (policy as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  // Reading is not a change, so read-only mode leaves it alone; this switch is its own.
  if (p.allowLogStreaming === false) {
    out['logs:read'] = 'This cluster’s agent policy does not allow streaming logs.';
  }
  if (p.readOnly === true) {
    for (const permission of ASKED) {
      if (!READ_ONLY_ALLOWS.has(permission)) {
        out[permission] = 'This cluster’s agent is set to read-only, so it refuses every change.';
      }
    }
    return out;
  }
  if (p.allowRestore === false) {
    out['restore:create'] = 'This cluster’s agent policy does not allow restores.';
  }
  if (p.allowBslWrite === false) {
    out['storage:write'] = 'This cluster’s agent policy does not allow changing storage locations.';
  }
  return out;
}

@ApiTags('rbac')
@Controller('orgs/:orgId/clusters/:clusterId')
export class AccessController {
  constructor(
    private readonly rbac: RbacService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('access')
  @AllowsApiToken()
  @RequirePermission('cluster:read')
  @ApiOperation({
    summary: 'What the caller may do on this cluster',
    description:
      'Per permission: `cluster` (everywhere), `scoped` (only in some namespaces) or `none`. What the cluster agent’s own policy refuses (read-only, no restores, no storage changes) shows as `none`, with the reason in `blocked`. A hint for the UI; each request is still authorized on its own.',
  })
  async access(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Req() request: Request,
  ) {
    const org = parseBody(orgIdParam, orgId);
    const cluster = parseBody(orgIdParam, clusterId);
    const access = await this.rbac.access(org, user.id, cluster, ASKED, request.apiToken);
    const row = await this.prisma.inOrg(org, () =>
      this.prisma.cluster.findUnique({ where: { id: cluster }, select: { agentPolicy: true } }),
    );
    const blocked = policyBlocks(row?.agentPolicy);
    for (const permission of Object.keys(blocked)) {
      access[permission] = 'none';
    }
    return { access, blocked };
  }
}
