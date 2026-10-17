import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { setAuditContext } from '../audit/audit.middleware';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { SessionService } from '../auth/session.service';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RbacService } from '../rbac/rbac.service';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { startLogSessionBody } from './log-request';
import { LogSessionsService, type LogEvent } from './log-sessions.service';

const PING_EVERY_MS = 15_000;
const RECHECK_EVERY_MS = 30_000;

/** Tunable so tests need not wait out the real windows. */
export const logStreamOptions = { pingMs: PING_EVERY_MS, recheckMs: RECHECK_EVERY_MS };

/**
 * Live container logs (PLAN.md §7.2, §10). Browser sessions only: a log can be read
 * through an API token no more than it can be streamed to a script, and nothing here
 * asks for `@AllowsApiToken`.
 *
 * `POST` starts nothing yet — it checks, records and audits the request; the agent is
 * asked to start when the stream is opened, so no line is produced before there is
 * somebody to receive it.
 */
@ApiTags('logs')
@Controller('orgs/:orgId/clusters/:clusterId')
export class LogSessionsController {
  constructor(
    private readonly sessions: LogSessionsService,
    private readonly rbac: RbacService,
    private readonly auth: SessionService,
  ) {}

  @Post('log-sessions')
  @RequirePermission('logs:read', { checkInHandler: true })
  @ApiOperation({
    summary: 'Start a live log session for one container',
    description:
      'Returns the session to stream from. Needs `logs:read` on the pod’s namespace, an agent policy that allows it, and a connected agent. Every start is audited with the namespace, pod and container — never the log.',
  })
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Body() raw: unknown,
    @Req() request: Request,
  ) {
    const body = parseBody(startLogSessionBody, raw);
    // Before the checks, so a refusal is audited with what was asked for.
    setAuditContext(request, {
      targetType: 'log_session',
      details: {
        namespace: body.namespace,
        pod: body.pod,
        container: body.container ?? null,
        previous: body.previous,
      },
    });
    const created = await this.sessions.create(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      body,
    );
    setAuditContext(request, { targetId: created.sessionId });
    return { ...created, streamUrl: `log-sessions/${created.sessionId}/stream` };
  }

  @Delete('log-sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('logs:read', { checkInHandler: true })
  @ApiOperation({ summary: 'Stop a live log session' })
  async stop(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    await this.sessions.stop(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
      parseBody(orgIdParam, sessionId),
    );
  }

  @Get('log-sessions/:sessionId/stream')
  @RequirePermission('logs:read', { checkInHandler: true })
  @ApiOperation({
    summary: 'Server-sent events for a log session: `chunk` events, then one `ended`',
    description:
      'Nothing is stored, so lines produced while no stream is open are not replayed. The agent starts the session when the first stream opens.',
  })
  async stream(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgIdRaw: string,
    @Param('clusterId') clusterIdRaw: string,
    @Param('sessionId') sessionIdRaw: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const orgId = parseBody(orgIdParam, orgIdRaw);
    const clusterId = parseBody(orgIdParam, clusterIdRaw);
    const sessionId = parseBody(orgIdParam, sessionIdRaw);
    const loginId = request.session?.id;
    if (loginId === undefined) {
      throw new BadRequestException('a log stream needs a browser session');
    }
    const record = await this.sessions.get(orgId, user.id, clusterId, sessionId);

    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    // No `retry:`: a dropped stream cannot be resumed (nothing is stored), so the browser
    // is told to reconnect only by the page deciding to, not by EventSource on its own.
    response.write(': connected\n\n');

    let ended = false;
    const send = (event: LogEvent): void => {
      if (ended) {
        return;
      }
      if (event.kind === 'chunk') {
        response.write(
          `event: chunk\nid: ${event.sequence.toString()}\ndata: ${JSON.stringify({ text: event.text })}\n\n`,
        );
      } else {
        ended = true;
        response.write(
          `event: ended\ndata: ${JSON.stringify({ reason: event.reason, message: event.message })}\n\n`,
        );
        response.end();
      }
    };

    const detach = await this.sessions.attach(orgId, user.id, clusterId, sessionId, send);

    const timers = [
      setInterval(() => {
        response.write(': ping\n\n');
        this.sessions.touchAlive(sessionId).catch(() => undefined);
      }, logStreamOptions.pingMs),
      // A permission taken away, or a login that has ended, ends the stream: it must not
      // outlive the right to read what it carries.
      setInterval(() => {
        void this.recheck(orgId, user.id, clusterId, loginId, record.namespace, sessionId);
      }, logStreamOptions.recheckMs),
    ];

    request.on('close', () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
      detach();
    });
  }

  @Get('log-shortcuts')
  @RequirePermission('logs:read', { checkInHandler: true })
  @ApiOperation({
    summary: 'The Velero server and node-agent pods, for one-click log views',
    description:
      'Found by the controller that owns each pod. Empty when Velero’s namespace is not known yet or its pods are not named as Velero names them; the pod picker still works.',
  })
  async shortcuts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
  ) {
    return this.sessions.shortcuts(
      parseBody(orgIdParam, orgId),
      user.id,
      parseBody(orgIdParam, clusterId),
    );
  }

  private async recheck(
    orgId: string,
    userId: string,
    clusterId: string,
    loginId: string,
    namespace: string,
    sessionId: string,
  ): Promise<void> {
    try {
      const live = await this.auth.isLive(loginId);
      const { decision } = await this.rbac.decide(orgId, userId, {
        clusterId,
        permission: 'logs:read',
        namespaces: [namespace],
      });
      if (!live || !decision.allowed) {
        await this.sessions.finish(
          sessionId,
          'revoked',
          'You no longer have access to these logs.',
          true,
        );
      }
    } catch {
      // Doubt must not end a stream that is fine; the next check tries again.
    }
  }
}
