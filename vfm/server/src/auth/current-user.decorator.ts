import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from './authenticated-user';

/**
 * Injects the authenticated user that `SessionGuard` attached.
 *
 * Throws rather than returning undefined on an unauthenticated request: that
 * can only happen if a handler is `@Public()` *and* asks for a user, which is
 * a programming error worth surfacing loudly in development.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (user === undefined) {
      throw new Error(
        'CurrentUser used on a route without an authenticated session — remove @Public() or the decorator',
      );
    }
    return user;
  },
);
