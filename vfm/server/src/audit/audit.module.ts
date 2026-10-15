import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';

import { OrgsModule } from '../orgs/orgs.module';
import { AuditController } from './audit.controller';
import { AuditMiddleware } from './audit.middleware';
import { AuditService } from './audit.service';

/** The audit log: recording, listing and CSV export (PLAN.md §8.4). */
@Module({
  imports: [OrgsModule],
  controllers: [AuditController],
  providers: [AuditService, AuditMiddleware],
  exports: [AuditService],
})
export class AuditModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuditMiddleware).forRoutes('*');
  }
}
