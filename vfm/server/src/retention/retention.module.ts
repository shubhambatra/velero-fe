import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { RetentionService } from './retention.service';

@Module({ imports: [AuditModule], providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}
