import { RateLimit } from '../common/rate-limit';
import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { OrgAccessService } from '../orgs/org-access.service';
import { AuditService, type AuditEventView } from './audit.service';
import { csvRow } from './csv';

const filterSchema = z.object({
  actorId: z.uuid().optional(),
  action: z.string().trim().min(1).max(100).optional(),
  clusterId: z.uuid().optional(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const listSchema = filterSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

const CSV_HEADER = [
  'time',
  'actor_type',
  'actor_id',
  'actor_email',
  'action',
  'target_type',
  'target_id',
  'cluster_id',
  'outcome',
  'ip',
  'user_agent',
  'request_id',
  'details',
] as const;

const csvLine = (e: AuditEventView): string =>
  csvRow([
    e.createdAt,
    e.actorType,
    e.actorId,
    e.actorEmail,
    e.action,
    e.targetType,
    e.targetId,
    e.clusterId,
    e.outcome,
    e.ip,
    e.userAgent,
    e.requestId,
    e.details,
  ]);

/** `/orgs/{orgId}/audit` (PLAN.md §10, §11 screen 10). Owner and Admin only. */
@ApiTags('audit')
@Controller('orgs/:orgId/audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly access: OrgAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Audit log, newest first (Owner/Admin)' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Query() query: unknown,
  ) {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    const { limit, cursor, ...filter } = parseBody(listSchema, query);
    return this.audit.list(id, filter, { limit, cursor });
  }

  @RateLimit('audit-export', 10, 60)
  @Get('export')
  @ApiOperation({ summary: 'Audit log as CSV (Owner/Admin); the export is itself audited' })
  async export(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Query() query: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const id = parseBody(orgIdParam, orgId);
    await this.access.require(user.id, id, 'ADMIN');
    const filter = parseBody(filterSchema, query);

    response.status(200);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    // Reading the whole log is a data-egress event worth its own row.
    response.write(csvRow(CSV_HEADER));
    let rows = 0;
    for await (const batch of this.audit.iterate(id, filter)) {
      for (const event of batch) {
        response.write(csvLine(event));
        rows += 1;
      }
    }
    response.end();

    this.audit.record({
      orgId: id,
      actorType: 'USER',
      actorId: user.id,
      action: 'audit.export',
      outcome: 'SUCCESS',
      details: { rows, filter: Object.keys(filter) },
    });
  }
}
