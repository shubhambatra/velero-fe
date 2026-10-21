import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RateLimit } from '../common/rate-limit';
import { parseBody } from '../common/parse-body';
import { OrgAccessService } from '../orgs/org-access.service';
import { orgIdParam } from '../orgs/orgs.dto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * `/orgs/{orgId}/config-export` (SOW FR-19): the organization's own configuration as one JSON
 * file. Credentials never appear: no password hashes, MFA secrets, tokens, certificates or
 * channel settings (those are encrypted and stay in the database backup). Cluster entries
 * carry connection metadata only, so re-enrolling an agent is the way back for a cluster.
 */
@ApiTags('config-backup')
@Controller('orgs/:orgId/config-export')
export class ConfigBackupController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  @RateLimit('config-export', 5, 60)
  @Get()
  @ApiOperation({
    summary: 'Download the organization configuration as JSON, without secrets (Owner/Admin)',
  })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Res() response: Response,
  ): Promise<void> {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    await this.access.require(user.id, orgId, 'ADMIN');
    const p = this.prisma;
    const data = await p.inOrg(orgId, async () => ({
      organization: await p.organization.findUnique({
        where: { id: orgId },
        select: { id: true, name: true, slug: true, settings: true },
      }),
      memberships: await p.membership.findMany({
        select: { userId: true, orgRole: true, user: { select: { email: true, name: true } } },
      }),
      teams: await p.team.findMany({
        select: {
          id: true,
          name: true,
          description: true,
          members: { select: { userId: true } },
        },
      }),
      clusters: await p.cluster.findMany({
        select: {
          id: true,
          name: true,
          status: true,
          labels: true,
          environmentType: true,
          apiEndpoint: true,
          owner: true,
          k8sVersion: true,
          veleroVersion: true,
          requireRestoreApproval: true,
          grafanaUrlTemplate: true,
        },
      }),
      roleBindings: await p.roleBinding.findMany({
        select: {
          clusterId: true,
          subjectType: true,
          subjectId: true,
          role: true,
          scope: true,
        },
      }),
      alertRules: await p.alertRule.findMany({
        select: {
          name: true,
          type: true,
          scope: true,
          params: true,
          channelIds: true,
          enabled: true,
        },
      }),
      notificationChannels: await p.notificationChannel.findMany({
        select: { id: true, name: true, type: true },
      }),
    }));
    const body = { exportedAt: new Date().toISOString(), version: 1, ...data };
    response.status(200);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="vfm-config.json"');
    response.send(JSON.stringify(body, null, 2));
    this.audit.record({
      orgId,
      actorType: 'USER',
      actorId: user.id,
      action: 'config.export',
      outcome: 'SUCCESS',
      details: { clusters: data.clusters.length },
    });
  }
}
