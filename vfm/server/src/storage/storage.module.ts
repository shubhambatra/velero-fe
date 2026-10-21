import { Module } from '@nestjs/common';

import { CommandsModule } from '../commands/commands.module';
import { RbacModule } from '../rbac/rbac.module';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

/** Backup and snapshot location operations on a cluster's agent (PLAN.md §16 day 26). */
@Module({
  imports: [CommandsModule, RbacModule],
  controllers: [StorageController],
  providers: [StorageService],
})
export class StorageModule {}
