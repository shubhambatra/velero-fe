import { Module } from '@nestjs/common';

import { CommandsModule } from '../commands/commands.module';
import { RbacModule } from '../rbac/rbac.module';
import { DownloadsController } from './downloads.controller';
import { DownloadsService } from './downloads.service';

/** Velero's per-backup and per-restore files, fetched through the agent (PLAN.md §7.3). */
@Module({
  imports: [CommandsModule, RbacModule],
  controllers: [DownloadsController],
  providers: [DownloadsService],
})
export class DownloadsModule {}
