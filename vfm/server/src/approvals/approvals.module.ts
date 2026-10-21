import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CommandsModule } from '../commands/commands.module';
import { OrgsModule } from '../orgs/orgs.module';
import { RbacModule } from '../rbac/rbac.module';
import { ApprovalPolicyService } from './approval-policy.service';
import { ClusterApprovalController } from './cluster-approval.controller';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

/** Optional approval of restores by a second person (PLAN.md §8.4, §16 day 35). */
@Module({
  imports: [AuthModule, CommandsModule, OrgsModule, RbacModule],
  controllers: [ApprovalsController, ClusterApprovalController],
  providers: [ApprovalsService, ApprovalPolicyService],
  exports: [ApprovalsService, ApprovalPolicyService],
})
export class ApprovalsModule {}
