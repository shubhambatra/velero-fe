import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ClustersModule } from '../clusters/clusters.module';
import { OrgsModule } from '../orgs/orgs.module';
import { RbacModule } from '../rbac/rbac.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** Success rate, namespace coverage and RPO compliance (PLAN.md §16 day 34). */
@Module({
  imports: [AuthModule, AuditModule, ClustersModule, OrgsModule, RbacModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
