import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC } from './public.decorator';
import { SessionService } from './session.service';

/** Methods that cannot change state and so need no token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit CSRF protection (PLAN.md §8.3: "double-submit token on all
 * state-changing REST calls").
 *
 * The session cookie is `SameSite=Lax`, which already blocks cross-site
 * *POST* requests in current browsers. This guard is the second layer, because
 * SameSite alone is not enough:
 *
 *   - `Lax` still sends the cookie on top-level cross-site **GET** navigations,
 *     so any state-changing GET would be exposed — this guard refuses to treat
 *     a GET as state-changing at all, which is why the API never uses one that
 *     way.
 *   - a same-site subdomain that an attacker controls or has XSS on is not
 *     "cross-site" for cookie purposes.
 *   - older browsers and non-browser clients do not enforce it.
 *
 * We compare the submitted header against the token **stored in the session**,
 * not merely against a second cookie. Classic double-submit trusts that an
 * attacker cannot write a cookie, which a subdomain often can; the session
 * copy cannot be written by anyone who does not already hold the session.
 *
 * Requests authenticated with an API token (`Authorization: Bearer`, §8.3) are
 * exempt: they carry no cookie, so there is nothing for a browser to attach
 * ambiently and therefore no CSRF to prevent.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(request.method)) {
      return true;
    }

    const isPublic =
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    // A public state-changing route (login, the one-time setup) has no session
    // yet, so there is no token to compare. Those routes are protected by the
    // throttle and by being single-use rather than by CSRF.
    if (isPublic) {
      return true;
    }

    // Only a request that authenticated with an API token is exempt. Merely
    // sending an Authorization header must not skip the check for a cookie
    // session.
    if (request.apiToken !== undefined) {
      return true;
    }

    const session = request.session;
    if (session === undefined) {
      // Unauthenticated: let the session guard produce the 401 rather than
      // reporting this as a CSRF failure, which would be misleading.
      return true;
    }

    const submitted = request.headers[CSRF_HEADER];
    if (typeof submitted !== 'string' || submitted === '') {
      throw new ForbiddenException(`missing ${CSRF_HEADER} header`);
    }

    if (!SessionService.csrfMatches(session.csrfToken, submitted)) {
      throw new ForbiddenException('CSRF token mismatch');
    }

    return true;
  }
}
