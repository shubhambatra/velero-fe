import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { newId } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelsService } from './channels/channels.service';
import { ALERT_RULE_TYPES, parseParams, scopeSchema, type AlertRuleType } from './rule-params';

const channelIds = z.array(z.uuid()).max(20);

export const createRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(ALERT_RULE_TYPES),
    scope: scopeSchema.default({ clusterIds: [] }),
    params: z.record(z.string(), z.unknown()).default({}),
    channelIds: channelIds.default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

/** The type of a rule never changes: its params would mean something else. */
export const updateRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    scope: scopeSchema.optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    channelIds: channelIds.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

export const listEventsQuery = z.object({
  state: z.enum(['FIRING', 'RESOLVED']).optional(),
  ruleId: z.uuid().optional(),
  clusterId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

const MAX_RULES_PER_ORG = 200;

@Injectable()
export class AlertRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelsService,
  ) {}

  list(orgId: string) {
    return this.prisma.inOrg(orgId, async () => {
      const rules = await this.prisma.alertRule.findMany({
        where: { orgId },
        orderBy: { createdAt: 'asc' },
      });
      const firing = await this.prisma.alertEvent.groupBy({
        by: ['ruleId'],
        where: { orgId, state: 'FIRING' },
        _count: { _all: true },
      });
      const counts = new Map(firing.map((f) => [f.ruleId, f._count._all]));
      return rules.map((r) => ({ ...r, firing: counts.get(r.id) ?? 0 }));
    });
  }

  async create(orgId: string, body: z.infer<typeof createRuleSchema>) {
    const params = this.params(body.type, body.params);
    await this.assertClusters(orgId, body.scope.clusterIds);
    await this.channels.assertAll(orgId, body.channelIds);
    return this.prisma.inOrg(orgId, async () => {
      if ((await this.prisma.alertRule.count({ where: { orgId } })) >= MAX_RULES_PER_ORG) {
        throw new BadRequestException(
          `an organization may have at most ${MAX_RULES_PER_ORG.toString()} alert rules`,
        );
      }
      return this.prisma.alertRule.create({
        data: {
          id: newId(),
          orgId,
          name: body.name,
          type: body.type,
          scope: body.scope,
          params: params as Prisma.InputJsonObject,
          channelIds: body.channelIds,
          enabled: body.enabled,
        },
      });
    });
  }

  async update(orgId: string, ruleId: string, body: z.infer<typeof updateRuleSchema>) {
    return this.prisma.inOrg(orgId, async () => {
      const rule = await this.prisma.alertRule.findFirst({ where: { id: ruleId, orgId } });
      if (rule === null) throw new NotFoundException('alert rule not found');
      if (body.scope !== undefined) await this.assertClusters(orgId, body.scope.clusterIds);
      if (body.channelIds !== undefined) await this.channels.assertAll(orgId, body.channelIds);
      return this.prisma.alertRule.update({
        where: { id: ruleId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.scope === undefined ? {} : { scope: body.scope }),
          ...(body.params === undefined
            ? {}
            : {
                params: this.params(rule.type, body.params) as Prisma.InputJsonObject,
              }),
          ...(body.channelIds === undefined ? {} : { channelIds: body.channelIds }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        },
      });
    });
  }

  async remove(orgId: string, ruleId: string): Promise<void> {
    await this.prisma.inOrg(orgId, async () => {
      const result = await this.prisma.alertRule.deleteMany({ where: { id: ruleId, orgId } });
      if (result.count === 0) throw new NotFoundException('alert rule not found');
    });
  }

  events(orgId: string, query: z.infer<typeof listEventsQuery>) {
    return this.prisma.inOrg(orgId, async () => {
      const rows = await this.prisma.alertEvent.findMany({
        where: {
          orgId,
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.ruleId === undefined ? {} : { ruleId: query.ruleId }),
          ...(query.clusterId === undefined ? {} : { clusterId: query.clusterId }),
          ...(query.cursor === undefined ? {} : { id: { lt: query.cursor } }),
        },
        // Ids are UUIDv7: newest first is highest first.
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      // Separate queries: the org scope cannot be applied to a to-one include.
      const [rules, clusters] = await Promise.all([
        this.prisma.alertRule.findMany({
          where: { orgId, id: { in: [...new Set(page.map((e) => e.ruleId))] } },
          select: { id: true, name: true, type: true },
        }),
        this.prisma.cluster.findMany({
          where: { orgId, id: { in: [...new Set(page.map((e) => e.clusterId))] } },
          select: { id: true, name: true },
        }),
      ]);
      const deliveries = await this.prisma.alertDelivery.findMany({
        where: { orgId, eventId: { in: page.map((e) => e.id) } },
        orderBy: { createdAt: 'asc' },
        select: {
          eventId: true,
          channelId: true,
          channelName: true,
          kind: true,
          ok: true,
          error: true,
          createdAt: true,
        },
      });
      const ruleOf = new Map(rules.map((r) => [r.id, r]));
      const clusterOf = new Map(clusters.map((c) => [c.id, c.name]));
      return {
        events: page.map((e) => ({
          id: e.id,
          ruleId: e.ruleId,
          ruleName: ruleOf.get(e.ruleId)?.name ?? null,
          ruleType: ruleOf.get(e.ruleId)?.type ?? null,
          clusterId: e.clusterId,
          clusterName: clusterOf.get(e.clusterId) ?? null,
          state: e.state,
          fingerprint: e.fingerprint,
          payload: e.payload,
          firedAt: e.firedAt,
          resolvedAt: e.resolvedAt,
          lastNotifiedAt: e.lastNotifiedAt,
          deliveries: deliveries
            .filter((d) => d.eventId === e.id)
            .map(({ eventId: _e, ...d }) => d),
        })),
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }

  private params(type: AlertRuleType, raw: unknown): Record<string, unknown> {
    const result = parseParams(type, raw);
    if (!result.ok) throw new BadRequestException(`params: ${result.message}`);
    return result.value;
  }

  /** A rule may only name clusters of its own org: anything else is a 400, not a rule that watches nothing. */
  private async assertClusters(orgId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.count({ where: { orgId, id: { in: ids } } }),
    );
    if (found !== new Set(ids).size) {
      throw new BadRequestException(
        'scope.clusterIds names a cluster that is not in this organization',
      );
    }
  }
}
