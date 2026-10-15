import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'vfm:isPublic';

/**
 * Marks a route as reachable without a session.
 *
 * Authentication is deny-by-default: `SessionGuard` is registered globally, so
 * a new controller is protected the moment it exists and opening a route is an
 * explicit, greppable act. PLAN.md §12.1 treats every boundary as untrusted,
 * and the failure mode of opt-in auth is a route nobody remembered to guard.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
