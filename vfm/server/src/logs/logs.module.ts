import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { RbacModule } from '../rbac/rbac.module';
import { StreamsModule } from '../streams/streams.module';
import { LogSessionsController } from './log-sessions.controller';
import { LogSessionsService } from './log-sessions.service';

/** Live container logs through the agent, kept nowhere (PLAN.md §7.2). */
@Module({
  imports: [AuthModule, InventoryModule, RbacModule, StreamsModule],
  controllers: [LogSessionsController],
  providers: [LogSessionsService],
})
export class LogsModule {}
