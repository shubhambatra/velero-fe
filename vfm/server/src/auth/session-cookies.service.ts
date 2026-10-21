import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { SessionService, type CreatedSession } from './session.service';

/**
 * Writes and clears the session and CSRF cookies (PLAN.md §8.3).
 *
 * Shared by the login and MFA controllers so the attributes are defined once.
 * `clearCookie` only works when the attributes match the ones used to set the
 * cookie, which is exactly the sort of detail that drifts when two controllers
 * each keep their own copy.
 */
@Injectable()
export class SessionCookiesService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Sets both cookies for a newly created or rotated session. */
  issue(response: Response, session: CreatedSession): void {
    response.cookie(SessionService.COOKIE, session.id, this.sessionOptions());
    response.cookie(SessionService.CSRF_COOKIE, session.csrfToken, this.csrfOptions());
  }

  /** Removes both cookies, used on logout. */
  clear(response: Response): void {
    response.clearCookie(SessionService.COOKIE, this.sessionOptions());
    response.clearCookie(SessionService.CSRF_COOKIE, this.csrfOptions());
  }

  /** PLAN.md §8.3: httpOnly, Secure, SameSite=Lax. */
  private sessionOptions(): CookieOptions {
    return {
      httpOnly: true,
      // Secure would make the cookie unusable over plain-HTTP localhost, so it
      // follows the environment. Every real deployment is TLS-only (§12.1).
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SessionService.ABSOLUTE_TTL_MS,
    };
  }

  /**
   * The CSRF cookie is intentionally **not** httpOnly: the SPA has to read it
   * to echo it back in the header. It is not a credential on its own — it is
   * only accepted alongside a session cookie whose stored token it must match.
   */
  private csrfOptions(): CookieOptions {
    return {
      httpOnly: false,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SessionService.ABSOLUTE_TTL_MS,
    };
  }
}
