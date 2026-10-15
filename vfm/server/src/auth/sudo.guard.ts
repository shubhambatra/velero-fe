import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

export const REQUIRES_SUDO = 'vfm:requiresSudo';

/**
 * Marks a route as requiring recent re-authentication — "sudo mode".
 *
 * PLAN.md §8.3 names the operations: restore create, any delete, storage
 * write, cluster delete, and role binding changes. The common thread is that
 * each is hard or impossible to undo, so holding a session that was
 * authenticated hours ago is not enough; the caller has to prove *now* that
 * they are still the person who signed in.
 *
 * Applied to the handlers that land in M2–M6. The guard exists from day 5 so
 * those handlers can be written with it from the start rather than retrofitted.
 */
export const RequiresSudo = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRES_SUDO, true);

/**
 * Enforces the 5-minute re-authentication window of PLAN.md §8.3.
 *
 * The window is measured from `lastReauthAt` on the session, which login sets
 * and `POST /auth/sudo` refreshes. Keeping it on the session rather than in a
 * separate store means revoking the session revokes the elevation with it.
 *
 * Returning **403 with a machine-readable marker** rather than 401 is
 * deliberate: the caller *is* authenticated, and a 401 would send a browser
 * client to the login page and lose the user's work. `sudoRequired` lets the
 * UI prompt for a password or a code in place and retry.
 */
@Injectable()
export class SudoGuard implements CanActivate {
  /** §8.3: "within the last 5 minutes". */
  static readonly WINDOW_MS = 5 * 60 * 1_000;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<boolean | undefined>(REQUIRES_SUDO, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const session = request.session;

    if (session === undefined) {
      // Unauthenticated: let SessionGuard produce the 401. Reporting a sudo
      // failure here would be misleading.
      return true;
    }

    if (!isFresh(session.lastReauthAt)) {
      throw new ForbiddenException({
        message: 'recent re-authentication required',
        sudoRequired: true,
      });
    }

    return true;
  }
}

/** Whether a re-authentication timestamp still falls inside the window. */
export function isFresh(lastReauthAt: number, now: number = Date.now()): boolean {
  const age = now - lastReauthAt;
  // A timestamp from the future means a clock jumped backwards; treat it as
  // stale rather than as indefinitely valid.
  return age >= 0 && age <= SudoGuard.WINDOW_MS;
}
