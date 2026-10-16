import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { StreamsModule } from '../streams/streams.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/** Velero inventory ingest and its read model (PLAN.md §5.3, §16 day 17). */
@Module({
  imports: [RbacModule, StreamsModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
