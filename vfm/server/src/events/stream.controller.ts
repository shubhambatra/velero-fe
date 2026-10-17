import { RateLimit } from '../common/rate-limit';
import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Permission } from '@vfm/shared';
import type { Request, Response } from 'express';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionService } from '../auth/session.service';
import { permissionForKindName } from '../inventory/kinds';
import { OrgAccessService } from '../orgs/org-access.service';
import { RbacService } from '../rbac/rbac.service';
import { EventsService, type PlatformEvent } from './events.service';

/** Concurrent streams per user: a runaway tab loop must not exhaust the server. */
export const MAX_STREAMS_PER_USER = 10;
const PING_EVERY_MS = 25_000;
const SESSION_CHECK_EVERY_MS = 60_000;

/** Tunable so tests need not wait out the real windows. */
export const streamOptions = {
  /** How long a permission decision is reused before it is made again. */
  permissionTtlMs: 10_000,
  pingMs: PING_EVERY_MS,
  sessionCheckMs: SESSION_CHECK_EVERY_MS,
};

/**
 * `GET /api/v1/stream`: server-sent events for the caller's active organization
 * (PLAN.md §10).
 *
 * ## Per-user filtering
 * Every event is checked against the **receiving user's** permissions before it is
 * written, and events are thin (see `EventsService`): they say a kind changed on a
 * cluster, never which object. A user without `backup:read` on a cluster therefore
 * does not learn that a backup was created there, only what `cluster:read` already
 * tells them. The browser re-reads through the REST API, which applies the full
 * rules, so there is exactly one place that decides what a user may see.
 *
 * Permission decisions are cached for a few seconds per connection. That is a
 * deliberate bound on how long a revoked grant can keep delivering events, not an
 * oversight; a role change is reflected within `permissionTtlMs`.
 *
 * Sessions only. An API token has no business holding a browser stream open.
 */
@ApiTags('stream')
@Controller('stream')
export class StreamController {
  private readonly open = new Map<string, number>();

  constructor(
    private readonly events: EventsService,
    private readonly rbac: RbacService,
    private readonly access: OrgAccessService,
    private readonly sessions: SessionService,
  ) {}

  @RateLimit('event-stream', 30, 60)
  @Get()
  @ApiOperation({
    summary: 'Server-sent events: cluster status, inventory changes and command progress',
    description: 'Events carry no object names. Re-read through the REST API on an event.',
  })
  async stream(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const orgId = request.session?.activeOrgId;
    const sessionId = request.session?.id;
    if (orgId === undefined || orgId === null || sessionId === undefined) {
      throw new BadRequestException('no active organization; select one first');
    }
    await this.access.require(user.id, orgId);

    const current = this.open.get(user.id) ?? 0;
    if (current >= MAX_STREAMS_PER_USER) {
      throw new HttpException('too many open event streams', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.open.set(user.id, current + 1);

    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies that buffer would hold events back indefinitely.
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    response.write('retry: 3000\n: connected\n\n');

    const decisions = new Map<string, { at: number; may: boolean }>();
    const may = async (clusterId: string, permission: Permission): Promise<boolean> => {
      const key = `${clusterId}/${permission}`;
      const cached = decisions.get(key);
      if (cached !== undefined && Date.now() - cached.at < streamOptions.permissionTtlMs) {
        return cached.may;
      }
      const result = await this.rbac
        .mayAttempt(orgId, user.id, clusterId, permission)
        .then((r) => r.may)
        // Doubt denies: if the check cannot be made, nothing is sent.
        .catch(() => false);
      decisions.set(key, { at: Date.now(), may: result });
      return result;
    };

    const send = (event: string, data: unknown): void => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const deliver = async (event: PlatformEvent): Promise<void> => {
      if (event.orgId !== orgId) {
        return;
      }
      if (event.type === 'cluster') {
        if (await may(event.clusterId, 'cluster:read')) {
          send('cluster', { clusterId: event.clusterId, status: event.status });
        }
      } else if (event.type === 'command') {
        if (await may(event.clusterId, 'cluster:read')) {
          send('command', {
            clusterId: event.clusterId,
            commandId: event.commandId,
            status: event.status,
          });
        }
      } else {
        const kinds: string[] = [];
        for (const kind of event.kinds) {
          const permission = permissionForKindName(kind);
          if (permission !== undefined && (await may(event.clusterId, permission))) {
            kinds.push(kind);
          }
        }
        if (kinds.length > 0) {
          send('inventory', { clusterId: event.clusterId, kinds });
        }
      }
    };

    // One chain per connection keeps events in the order they were published even
    // though each needs an asynchronous permission check.
    let chain: Promise<void> = Promise.resolve();
    const unsubscribe = this.events.subscribe((event) => {
      chain = chain.then(() => deliver(event)).catch(() => undefined);
    });

    const ping = setInterval(() => {
      response.write(': ping\n\n');
    }, streamOptions.pingMs);

    // A session that has ended (sign-out, expiry, revoked everywhere) ends the
    // stream; it must not outlive the login that opened it.
    const sessionCheck = setInterval(() => {
      this.sessions
        .isLive(sessionId)
        .then((live) => {
          if (!live) {
            response.end();
          }
        })
        .catch(() => undefined);
    }, streamOptions.sessionCheckMs);

    request.on('close', () => {
      unsubscribe();
      clearInterval(ping);
      clearInterval(sessionCheck);
      const left = (this.open.get(user.id) ?? 1) - 1;
      if (left <= 0) {
        this.open.delete(user.id);
      } else {
        this.open.set(user.id, left);
      }
    });
  }
}
