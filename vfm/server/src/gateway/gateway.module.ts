import { Module } from '@nestjs/common';

import { CaModule } from '../ca/ca.module';
import { ClustersModule } from '../clusters/clusters.module';
import { GatewayService } from './gateway.service';

/** The agent-facing gRPC listener (PLAN.md §5, §10). */
@Module({
  imports: [CaModule, ClustersModule],
  providers: [GatewayService],
  exports: [GatewayService],
})
export class GatewayModule {}
