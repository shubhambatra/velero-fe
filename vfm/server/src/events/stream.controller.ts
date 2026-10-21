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
import { sseConnects, sseSubscribers } from '../metrics/metrics';

/** Concurrent streams per user: a runaway tab loop must not exhaust the server. */
export const MAX_STREAMS_PER_USER = 10;
const PING_EVERY_MS = 25_000;
const SESSION_CHECK_EVERY_MS = 60_000;

/** Tunable so tests need not wait out the real windows. */
export const streamOptions = {
  /** How long a permission decision is reused before it is made again. */
  permissionTtlMs: 10_000,
  /**
   * Inventory changes of one cluster arriving within this window are sent as one event. A busy
   * fleet changes something every few milliseconds; a browser needs to be told once, then re-read.
   * 0 sends every event at once.
   */
  coalesceMs: 250,
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
    sseSubscribers.inc();
    sseConnects.inc();

    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies that buffer would hold events back indefinitely.
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    response.write('retry: 3000\n: connected\n\n');

    // What this person may read, for every cluster, from one set of queries that is renewed after
    // the permission TTL. Asked per cluster and per kind it was hundreds of lookups per stream.
    const PERMISSIONS: Permission[] = [
      'cluster:read',
      'backup:read',
      'restore:read',
      'schedule:read',
      'storage:read',
    ];
    let held: { at: number; byCluster: Map<string, Set<Permission>> } | undefined;
    const may = async (clusterId: string, permission: Permission): Promise<boolean> => {
      const fresh = held !== undefined && Date.now() - held.at < streamOptions.permissionTtlMs;
      // A cluster made since the last read is looked for once more, not refused until the TTL ends.
      const unknown =
        held !== undefined && !held.byCluster.has(clusterId) && Date.now() - held.at > 1_000;
      if (!fresh || unknown) {
        try {
          held = {
            at: Date.now(),
            byCluster: await this.rbac.heldAcrossOrg(orgId, user.id, PERMISSIONS),
          };
        } catch {
          // Doubt denies: if the check cannot be made, nothing is sent.
          return false;
        }
      }
      return held?.byCluster.get(clusterId)?.has(permission) === true;
    };

    const send = (event: string, data: unknown): void => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const sendInventory = async (clusterId: string, wanted: Iterable<string>): Promise<void> => {
      const kinds: string[] = [];
      for (const kind of wanted) {
        const permission = permissionForKindName(kind);
        if (permission !== undefined && (await may(clusterId, permission))) {
          kinds.push(kind);
        }
      }
      if (kinds.length > 0) {
        send('inventory', { clusterId, kinds });
      }
    };

    // Inventory events of a cluster are merged for a moment and sent together.
    const pending = new Map<string, Set<string>>();
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = (): void => {
      flushTimer = undefined;
      const batch = [...pending.entries()];
      pending.clear();
      chain = chain
        .then(async () => {
          for (const [clusterId, kinds] of batch) {
            await sendInventory(clusterId, kinds);
          }
        })
        .catch(() => undefined);
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
      } else if (streamOptions.coalesceMs <= 0) {
        await sendInventory(event.clusterId, event.kinds);
      } else {
        const kinds = pending.get(event.clusterId) ?? new Set<string>();
        for (const kind of event.kinds) kinds.add(kind);
        pending.set(event.clusterId, kinds);
        flushTimer ??= setTimeout(flush, streamOptions.coalesceMs);
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
      clearTimeout(flushTimer);
      clearInterval(ping);
      clearInterval(sessionCheck);
      sseSubscribers.dec();
      const left = (this.open.get(user.id) ?? 1) - 1;
      if (left <= 0) {
        this.open.delete(user.id);
      } else {
        this.open.set(user.id, left);
      }
    });
  }
}
