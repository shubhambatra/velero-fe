import { Module } from '@nestjs/common';

import { CommandsModule } from '../commands/commands.module';
import { RbacModule } from '../rbac/rbac.module';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';

/** Backup operations on a cluster's agent (PLAN.md §16 day 21). */
@Module({
  imports: [CommandsModule, RbacModule],
  controllers: [BackupsController],
  providers: [BackupsService],
})
export class BackupsModule {}
