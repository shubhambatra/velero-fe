import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { AuditActorType } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { AuditService } from './audit.service';

/** What a handler can add to the event the middleware will write. */
export interface AuditContext {
  actorId?: string;
  actorType?: AuditActorType;
  orgId?: string;
  targetType?: string;
  targetId?: string;
}

declare module 'express' {
  interface Request {
    auditContext?: AuditContext;
  }
}

/**
 * Lets a handler supply what the middleware cannot see on its own — the actor
 * of a login (no session exists yet) or the org it just created.
 */
export function setAuditContext(request: Request, context: AuditContext): void {
  request.auditContext = { ...request.auditContext, ...context };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const API_PREFIX = '/api/v1';
const MAX_FIELDS = 50;

/**
 * Audits every mutating API call (PLAN.md §16 day 9: "audit interceptor on all
 * mutating routes").
 *
 * A middleware on the response's `finish` event rather than a Nest
 * interceptor, because interceptors run *after* guards: a request refused by
 * authentication, CSRF, RBAC or sudo would never reach one, and a refusal is
 * exactly what an auditor wants to see. `finish` fires for every outcome.
 *
 * It is generic on purpose — a new mutating route is audited the moment it
 * exists, with no decorator to forget.
 *
 * ## What is recorded
 *
 * The route *pattern* (`POST /orgs/:orgId/teams`), the status, and the **names**
 * of the body fields. Never values: a body can carry a password, a token or a
 * client secret, and redaction by key name is a safety net, not a plan.
 */
@Injectable()
export class AuditMiddleware implements NestMiddleware {
  constructor(private readonly audit: AuditService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!MUTATING.has(req.method)) {
      next();
      return;
    }

    res.on('finish', () => {
      // An unmatched URL has no route; there is no action to attribute and a
      // scanner would otherwise fill the log with 404s.
      const pattern = (req.route as { path?: unknown } | undefined)?.path;
      if (typeof pattern !== 'string') {
        return;
      }
      this.audit.record(this.build(req, res, pattern));
    });

    next();
  }

  private build(req: Request, res: Response, pattern: string) {
    const context = req.auditContext ?? {};
    const params = req.params as Record<string, string | undefined>;
    const route = pattern.startsWith(API_PREFIX) ? pattern.slice(API_PREFIX.length) : pattern;

    // The last identifying parameter names the target: `/teams/:teamId/members/:userId`
    // is an action on a user, not on the team.
    const targetKey = Object.keys(params)
      .filter((key) => key !== 'orgId' && key !== 'clusterId')
      .pop();

    const status = res.statusCode;
    const outcome =
      status < 400 ? 'SUCCESS' : status === 401 || status === 403 ? 'DENIED' : 'FAILED';

    const body = req.body as unknown;
    const fields =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? Object.keys(body).slice(0, MAX_FIELDS)
        : [];

    const token = req.apiToken;
    const actorId = context.actorId ?? token?.id ?? req.user?.id ?? null;

    return {
      orgId: context.orgId ?? params.orgId ?? req.session?.activeOrgId ?? token?.orgId ?? null,
      actorType:
        context.actorType ?? (token === undefined ? ('USER' as const) : ('TOKEN' as const)),
      actorId,
      action: `${req.method} ${route}`,
      targetType:
        context.targetType ?? (targetKey === undefined ? null : targetKey.replace(/Id$/, '')),
      targetId: context.targetId ?? (targetKey === undefined ? null : (params[targetKey] ?? null)),
      clusterId: params.clusterId ?? null,
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      requestId: req.requestId ?? null,
      outcome: outcome,
      details: {
        status,
        fields,
        // For a token, the person it acts as.
        ...(token === undefined ? {} : { onBehalfOf: token.userId }),
      },
    } as const;
  }
}
