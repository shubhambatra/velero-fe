import { Module } from '@nestjs/common';

import { ClustersModule } from '../clusters/clusters.module';
import { OrgsModule } from '../orgs/orgs.module';
import { RbacModule } from '../rbac/rbac.module';
import { StreamsModule } from '../streams/streams.module';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/** Velero inventory ingest and its read model (PLAN.md §5.3, §16 day 17). */
@Module({
  imports: [ClustersModule, OrgsModule, RbacModule, StreamsModule],
  controllers: [InventoryController, FleetController, ResourcesController],
  providers: [InventoryService, FleetService, ResourcesService],
  exports: [InventoryService],
})
export class InventoryModule {}
