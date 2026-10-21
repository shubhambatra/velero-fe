import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { z } from 'zod';

import { RbacService } from './rbac.service';
import { REQUIRED_PERMISSION, type RequiredPermission } from './require-permission.decorator';

const uuid = z.uuid();

/**
 * Enforces `@RequirePermission` (PLAN.md §8.2).
 *
 * Runs after the global session guard, so `request.user` is set. A route that
 * carries `@RequirePermission` but somehow has no user is refused rather than
 * waved through.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined) {
      // The guard is only attached by the decorator, so this is a wiring
      // mistake. Failing closed makes it visible in the first test.
      throw new ForbiddenException();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (user === undefined) {
      throw new ForbiddenException();
    }

    const params = request.params as Record<string, string | undefined>;
    const clusterId = uuid.safeParse(params.clusterId);
    if (!clusterId.success) {
      // A malformed id cannot name a cluster; answer as for an unknown one.
      throw new NotFoundException('cluster not found');
    }

    const orgParam =
      params.orgId ?? request.session?.activeOrgId ?? request.apiToken?.orgId ?? undefined;
    const orgId = uuid.safeParse(orgParam);
    if (!orgId.success) {
      throw new BadRequestException('no active organization; select one first');
    }

    await this.rbac.assertClusterInOrg(orgId.data, clusterId.data);

    if (required.checkInHandler === true) {
      const { may, visible } = await this.rbac.mayAttempt(
        orgId.data,
        user.id,
        clusterId.data,
        required.permission,
        request.apiToken,
      );
      if (may) {
        return true;
      }
      throw visible
        ? new ForbiddenException(`missing permission ${required.permission}`)
        : new NotFoundException('cluster not found');
    }

    // Whole-cluster demand: no namespaces, no cluster-scoped flag. For a
    // namespaced permission and a scoped binding this denies, by design.
    await this.rbac.require(
      orgId.data,
      user.id,
      { clusterId: clusterId.data, permission: required.permission, namespaces: [] },
      request.apiToken,
    );
    return true;
  }
}
