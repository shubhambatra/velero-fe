import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { OidcAdminController } from './oidc-admin.controller';
import { OidcLoginService } from './oidc-login.service';
import { OidcProvidersService } from './oidc-providers.service';
import { OidcController } from './oidc.controller';

/** Per-org OpenID Connect sign-in (PLAN.md §8.3, §16 day 7). */
@Module({
  imports: [AuthModule, OrgsModule, AuditModule],
  controllers: [OidcController, OidcAdminController],
  providers: [OidcLoginService, OidcProvidersService],
})
export class OidcModule {}
