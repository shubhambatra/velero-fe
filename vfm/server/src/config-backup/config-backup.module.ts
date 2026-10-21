import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { ConfigBackupController } from './config-backup.controller';

/** Secret-free export of an organization's configuration (SOW FR-19). */
@Module({
  imports: [AuthModule, AuditModule, OrgsModule],
  controllers: [ConfigBackupController],
})
export class ConfigBackupModule {}
