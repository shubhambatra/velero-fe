import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import type { Permission } from '@vfm/shared';

import { RbacGuard } from './rbac.guard';

export const REQUIRED_PERMISSION = 'vfm:requiredPermission';

export interface RequiredPermission {
  permission: Permission;
  /**
   * The handler checks the request's namespaces itself with
   * `RbacService.require`. The guard then only confirms the caller holds the
   * permission somewhere, which is **not** an authorization decision.
   *
   * Without this flag the guard demands the permission across the whole
   * cluster, so forgetting the handler-side check fails closed for scoped
   * users instead of open.
   */
  checkInHandler?: boolean;
}

/**
 * Requires `permission` on the cluster named by the `:clusterId` route
 * parameter, within the org named by `:orgId` or, failing that, the session's
 * active org.
 */
export const RequirePermission = (
  permission: Permission,
  options: { checkInHandler?: boolean } = {},
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSION, { permission, ...options } satisfies RequiredPermission),
    UseGuards(RbacGuard),
  );
