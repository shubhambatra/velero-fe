import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BreachedPasswordsService } from './breached-passwords';
import { LoginThrottleService } from './login-throttle.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { RecoveryCodesService } from './recovery-codes.service';
import { SessionCookiesService } from './session-cookies.service';
import { SessionService } from './session.service';
import { SetupService } from './setup.service';
import { TotpService } from './totp.service';

/**
 * Local authentication (PLAN.md §8.3, §16 day 4).
 *
 * Several providers are exported because later milestones need them outside
 * this module: OIDC session creation in day 7, API tokens in day 9, and
 * `UsersService` needs `PasswordService` for sudo re-authentication today.
 */
@Module({
  controllers: [AuthController, MfaController],
  providers: [
    AuthService,
    BreachedPasswordsService,
    LoginThrottleService,
    MfaService,
    PasswordService,
    RecoveryCodesService,
    SessionCookiesService,
    SessionService,
    SetupService,
    TotpService,
  ],
  // PasswordService is exported because UsersService needs it for sudo
  // password re-authentication; the rest are needed by OIDC in day 7 and API
  // tokens in day 9.
  exports: [SessionService, PasswordService, MfaService, SessionCookiesService],
})
export class AuthModule {}
