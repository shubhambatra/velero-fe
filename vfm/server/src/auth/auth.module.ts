import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BreachedPasswordsService } from './breached-passwords';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { SetupService } from './setup.service';

/**
 * Local authentication (PLAN.md §8.3, §16 day 4).
 *
 * `SessionService` and `PasswordService` are exported because later milestones
 * need them outside this module: MFA and sudo re-auth in day 5, OIDC session
 * creation in day 7, API tokens in day 9.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    BreachedPasswordsService,
    LoginThrottleService,
    PasswordService,
    SessionService,
    SetupService,
  ],
  exports: [SessionService, PasswordService],
})
export class AuthModule {}
