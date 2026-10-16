import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { StreamsModule } from '../streams/streams.module';
import { CommandsController } from './commands.controller';
import { CommandsService } from './commands.service';

/** The command pipeline between the control plane and the agents (PLAN.md §5.4). */
@Module({
  imports: [RbacModule, StreamsModule],
  controllers: [CommandsController],
  providers: [CommandsService],
  exports: [CommandsService],
})
export class CommandsModule {}
