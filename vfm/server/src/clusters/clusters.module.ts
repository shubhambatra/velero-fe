import { Module } from '@nestjs/common';

import { CaModule } from '../ca/ca.module';
import { OrgsModule } from '../orgs/orgs.module';
import { RbacModule } from '../rbac/rbac.module';
import { StreamsModule } from '../streams/streams.module';
import { ClustersController } from './clusters.controller';
import { ClustersService } from './clusters.service';
import { EnrollmentService } from './enrollment.service';

/** Clusters, bootstrap tokens and agent enrollment (PLAN.md §5.1, M2 day 11). */
@Module({
  imports: [CaModule, OrgsModule, RbacModule, StreamsModule],
  controllers: [ClustersController],
  providers: [ClustersService, EnrollmentService],
  exports: [ClustersService, EnrollmentService],
})
export class ClustersModule {}
