import { Module } from '@nestjs/common';

import { AccessController } from './access.controller';
import { RbacGuard } from './rbac.guard';
import { RbacService } from './rbac.service';
import { RoleBindingsController } from './role-bindings.controller';
import { RoleBindingsService } from './role-bindings.service';

/** Role-based access control: engine glue, guard and role bindings (§8.2). */
@Module({
  controllers: [RoleBindingsController, AccessController],
  providers: [RbacService, RbacGuard, RoleBindingsService],
  exports: [RbacService, RbacGuard],
})
export class RbacModule {}
