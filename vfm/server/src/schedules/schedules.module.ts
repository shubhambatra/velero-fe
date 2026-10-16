import { Module } from '@nestjs/common';

import { CommandsModule } from '../commands/commands.module';
import { RbacModule } from '../rbac/rbac.module';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

/** Schedule operations on a cluster's agent (PLAN.md §16 day 25). */
@Module({
  imports: [CommandsModule, RbacModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
})
export class SchedulesModule {}
