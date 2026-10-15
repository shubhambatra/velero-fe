import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { UsersService } from '../users/users.service';
import { ALLOWS_MFA_PENDING } from './mfa-pending.decorator';
import { IS_PUBLIC } from './public.decorator';
import { SessionService } from './session.service';

/**
 * Resolves the session cookie into a user, or rejects the request.
 *
 * Registered globally, so authentication is **deny by default** (PLAN.md
 * §12.1): a controller added without thinking about auth is protected, and
 * opening a route requires writing `@Public()` where a reviewer will see it.
 *
 * The user row is re-read on every request rather than trusted from the
 * session. That is the whole point of server-side sessions (§9 puts them in
 * Redis precisely so they are revocable): disabling an account takes effect on
 * the next request, not whenever a cached copy happens to expire.
 *
 * ## Two gates, not one
 *
 * A session that passed the password check but owes a second factor is
 * `mfaPending`. It is a real session — it has to be, so the challenge can be
 * answered — but it authenticates nothing: every route refuses it except the
 * few marked `@AllowsMfaPending()` (the challenge, enrolment, logout).
 * Without that second gate, `mfaEnabled` would be a flag the login response
 * mentions rather than a control (PLAN.md §8.3).
 *
 * The refusal is **403 with `mfaRequired`**, not 401: the credentials were
 * accepted, and sending the client back to the login form would lose that.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    const request = context.switchToHttp().getRequest<Request>();

    const sessionId = readSessionCookie(request);
    if (sessionId !== undefined) {
      // Resolve the session even on a public route, so endpoints like login
      // can tell an already-authenticated caller apart from an anonymous one.
      await this.attach(request, sessionId);
    }

    if (isPublic) {
      return true;
    }

    if (request.user === undefined) {
      // One message for every failure mode — expired, revoked, absent,
      // disabled — so nothing here helps an attacker tell them apart.
      throw new UnauthorizedException('authentication required');
    }

    if (request.session?.mfaPending === true) {
      const allowsPending =
        this.reflector.getAllAndOverride<boolean | undefined>(ALLOWS_MFA_PENDING, [
          context.getHandler(),
          context.getClass(),
        ]) ?? false;

      if (!allowsPending) {
        const reason = request.session.mfaPendingReason;
        throw new ForbiddenException({
          message:
            reason === 'enrolment'
              ? 'multi-factor authentication must be set up before continuing'
              : 'multi-factor authentication required',
          mfaRequired: true,
          // Lets the UI send the user to enrolment rather than to a code
          // prompt they cannot answer.
          mfaPendingReason: reason,
        });
      }
    }

    return true;
  }

  private async attach(request: Request, sessionId: string): Promise<void> {
    const record = await this.sessions.touch(sessionId);
    if (record === null) {
      return;
    }

    const user = await this.users.findAuthenticatedById(record.userId);
    if (user === null) {
      // The user was deleted or disabled while the session was live. Drop the
      // session so it stops being presented.
      await this.sessions.destroy(sessionId);
      return;
    }

    request.session = { ...record, id: sessionId };
    request.user = user;
  }
}

function readSessionCookie(request: Request): string | undefined {
  const cookies: unknown = request.cookies;
  if (cookies === null || typeof cookies !== 'object') {
    return undefined;
  }
  const value = (cookies as Record<string, unknown>)[SessionService.COOKIE];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
