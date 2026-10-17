import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { CommandsModule } from '../commands/commands.module';
import { RbacModule } from '../rbac/rbac.module';
import { RestoresController } from './restores.controller';
import { RestoresService } from './restores.service';

/** Restore operations on a cluster's agent (PLAN.md §16 day 23). */
@Module({
  imports: [ApprovalsModule, CommandsModule, RbacModule],
  controllers: [RestoresController],
  providers: [RestoresService],
})
export class RestoresModule {}
