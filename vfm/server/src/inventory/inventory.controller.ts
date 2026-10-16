import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Permission } from '@vfm/shared';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AllowsApiToken } from '../tokens/api-token.decorator';
import { KIND_NAMES, permissionForKindName } from './kinds';

/**
 * `/orgs/{orgId}/clusters/{clusterId}/inventory`: how much of each kind the
 * cluster has, by phase. The full lists and detail pages arrive on day 19; this is
 * what the cluster overview needs and what proves the ingest worked.
 *
 * A kind the caller may not read is **absent**, not zero: a count of zero would
 * itself be information about a thing they are not allowed to see.
 */
@ApiTags('inventory')
@Controller('orgs/:orgId/clusters/:clusterId/inventory')
export class InventoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  @Get()
  @AllowsApiToken()
  @RequirePermission('cluster:read')
  @ApiOperation({
    summary: 'Counts of Velero objects by kind and phase, for the kinds you may read',
  })
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Param('clusterId') clusterIdRaw: string,
    @Req() request: Request,
  ) {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    const clusterId = parseBody(orgIdParam, clusterIdRaw);

    const permitted = new Map<Permission, boolean>();
    const allowed: string[] = [];
    for (const kind of KIND_NAMES) {
      const permission = permissionForKindName(kind);
      if (permission === undefined) {
        continue;
      }
      if (!permitted.has(permission)) {
        const { may } = await this.rbac.mayAttempt(
          orgId,
          user.id,
          clusterId,
          permission,
          // An API token can only narrow its owner's access, so its limits apply here too.
          request.apiToken,
        );
        permitted.set(permission, may);
      }
      if (permitted.get(permission) === true) {
        allowed.push(kind);
      }
    }

    const [cluster, groups] = await this.prisma.inOrg(orgId, () =>
      Promise.all([
        this.prisma.cluster.findUnique({
          where: { id: clusterId },
          select: { inventorySnapshotId: true, inventorySyncedAt: true },
        }),
        this.prisma.veleroResource.groupBy({
          by: ['kind', 'phase'],
          where: { clusterId, deletedAt: null, kind: { in: allowed } },
          _count: { _all: true },
        }),
      ]),
    );

    const kinds: Record<string, { total: number; byPhase: Record<string, number> }> = {};
    for (const kind of allowed) {
      kinds[kind] = { total: 0, byPhase: {} };
    }
    for (const group of groups) {
      const entry = kinds[group.kind];
      if (entry !== undefined) {
        entry.total += group._count._all;
        entry.byPhase[group.phase ?? 'Unknown'] = group._count._all;
      }
    }
    return {
      snapshotId: cluster?.inventorySnapshotId ?? null,
      syncedAt: cluster?.inventorySyncedAt ?? null,
      kinds,
    };
  }
}
