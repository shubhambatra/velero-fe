import { RateLimit } from '../common/rate-limit';
import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';

import PDFDocument from 'pdfkit';

import { csvRow } from '../audit/csv';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseBody } from '../common/parse-body';
import { OrgAccessService } from '../orgs/org-access.service';
import { orgIdParam } from '../orgs/orgs.dto';
import { window, ReportsService } from './reports.service';

const common = {
  clusterId: z.uuid().optional(),
  format: z.enum(['json', 'csv', 'pdf']).default('json'),
};
const instant = z.coerce.date().optional();

const successQuery = z
  .object({ ...common, from: instant, to: instant, bucket: z.enum(['day', 'week']).default('day') })
  .strict();
const coverageQuery = z
  .object({ ...common, hours: z.coerce.number().int().min(1).max(8_760).default(48) })
  .strict();
const rpoQuery = z
  .object({
    ...common,
    from: instant,
    to: instant,
    factor: z.coerce.number().min(1).max(10).default(1.5),
    targetHours: z.coerce.number().min(0.1).max(8_760).optional(),
  })
  .strict();

/** A plain table: title, generation time, then one line per row, wrapped to the page width. */
function renderPdf(out: Response, title: string, header: string[], rows: unknown[][]): void {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.pipe(out);
  doc.fontSize(14).text(`Velero Fleet Manager: ${title}`);
  doc.fontSize(8).fillColor('#555').text(`Generated ${new Date().toISOString()}`).moveDown();
  doc.fillColor('#000');
  const width = (doc.page.width - 72) / header.length;
  const line = (cells: unknown[], bold: boolean): void => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    let height = 0;
    cells.forEach((cell, i) => {
      const text =
        typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean'
          ? String(cell)
          : '';
      doc.text(text, 36 + i * width, y, { width: width - 4 });
      height = Math.max(height, doc.y - y);
    });
    doc.y = y + height + 3;
    if (doc.y > doc.page.height - 60) {
      doc.addPage();
    }
  };
  line(header, true);
  for (const row of rows) {
    line(row, false);
  }
  doc.end();
}

const pct = (v: number | null): string =>
  v === null ? '' : (Math.round(v * 10_000) / 100).toString();
const hrs = (v: number | null): string =>
  v === null ? '' : (Math.round(v * 100) / 100).toString();

/**
 * `/orgs/{orgId}/reports/*` (PLAN.md §10, §11.1 page 12). Any member may ask; each answer is
 * limited to the clusters, backups, schedules and namespaces the caller may read. `format=csv`
 * gives the same data as a spreadsheet, with formula-starting cells defused, and is audited.
 */
@ApiTags('reports')
@Controller('orgs/:orgId/reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly access: OrgAccessService,
    private readonly audit: AuditService,
  ) {}

  private tabular(
    format: 'csv' | 'pdf',
    response: Response,
    user: AuthenticatedUser,
    orgId: string,
    name: string,
    header: string[],
    rows: unknown[][],
  ): void {
    response.status(200);
    if (format === 'pdf') {
      response.setHeader('Content-Type', 'application/pdf');
      response.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
      renderPdf(response, name, header, rows);
    } else {
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
      response.send(csvRow(header) + rows.map((r) => csvRow(r)).join(''));
    }
    // An export leaves the system; it is worth a row of its own.
    this.audit.record({
      orgId,
      actorType: 'USER',
      actorId: user.id,
      action: `reports.export.${name}`,
      outcome: 'SUCCESS',
      details: { rows: rows.length },
    });
  }

  @RateLimit('reports', 30, 60)
  @Get('success-rate')
  @ApiOperation({
    summary:
      'Backups that finished, by outcome, per day or week and cluster, with the success rate',
  })
  async successRate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Query() raw: unknown,
    @Res() response: Response,
  ) {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    await this.access.require(user.id, orgId);
    const q = parseBody(successQuery, raw);
    const result = await this.reports.successRate(orgId, user.id, {
      ...window(q.from, q.to),
      bucket: q.bucket,
      clusterId: q.clusterId,
    });
    if (q.format === 'json') {
      response.json(result);
      return;
    }
    this.tabular(
      q.format,
      response,
      user,
      orgId,
      'success-rate',
      [
        'cluster',
        'period_start',
        'completed',
        'partially_failed',
        'failed',
        'success_rate_percent',
      ],
      result.clusters.flatMap((c) =>
        c.points.map((p) => [
          c.clusterName,
          p.start,
          p.completed,
          p.partiallyFailed,
          p.failed,
          pct(p.rate),
        ]),
      ),
    );
  }

  @RateLimit('reports', 30, 60)
  @Get('coverage')
  @ApiOperation({
    summary: 'Namespaces with no successful backup in the last N hours, or ever',
  })
  async coverage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Query() raw: unknown,
    @Res() response: Response,
  ) {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    await this.access.require(user.id, orgId);
    const q = parseBody(coverageQuery, raw);
    const result = await this.reports.coverage(orgId, user.id, {
      hours: q.hours,
      clusterId: q.clusterId,
    });
    if (q.format === 'json') {
      response.json(result);
      return;
    }
    this.tabular(
      q.format,
      response,
      user,
      orgId,
      'coverage',
      ['cluster', 'namespace', 'last_successful_backup', 'hours_since', 'has_schedule'],
      result.clusters.flatMap((c) =>
        c.namespaces.map((n) => [
          c.clusterName,
          n.namespace,
          n.lastBackupAt,
          hrs(n.hoursSince),
          n.scheduled,
        ]),
      ),
    );
  }

  @RateLimit('reports', 30, 60)
  @Get('rpo')
  @ApiOperation({
    summary:
      'Per schedule: the share of the time the newest successful backup was within the objective',
    description:
      'The objective is `factor` (default 1.5) times the schedule’s longest interval, or `targetHours` for every schedule. Paused schedules are left out.',
  })
  async rpo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Query() raw: unknown,
    @Res() response: Response,
  ) {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    await this.access.require(user.id, orgId);
    const q = parseBody(rpoQuery, raw);
    const result = await this.reports.rpo(orgId, user.id, {
      ...window(q.from, q.to),
      factor: q.factor,
      targetHours: q.targetHours,
      clusterId: q.clusterId,
    });
    if (q.format === 'json') {
      response.json(result);
      return;
    }
    this.tabular(
      q.format,
      response,
      user,
      orgId,
      'rpo',
      [
        'cluster',
        'schedule',
        'cron',
        'objective_hours',
        'compliance_percent',
        'measured_hours',
        'compliant_hours',
        'longest_gap_hours',
        'successful_backups',
        'last_successful_backup',
        'age_hours',
        'objective_met_now',
      ],
      result.schedules.map((s) => [
        s.clusterName,
        s.schedule,
        s.cron,
        hrs(s.targetHours),
        pct(s.compliance),
        hrs(s.measuredHours),
        hrs(s.compliantHours),
        hrs(s.longestGapHours),
        s.successes,
        s.lastSuccessAt,
        hrs(s.ageHours),
        s.metNow,
      ]),
    );
  }
}
