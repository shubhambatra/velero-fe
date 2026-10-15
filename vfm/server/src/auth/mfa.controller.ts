import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { parseBody } from '../common/parse-body';
import type { AuthenticatedUser } from './authenticated-user';
import { CurrentUser } from './current-user.decorator';
import { AllowsMfaPending } from './mfa-pending.decorator';
import { MfaService, type MfaStatus } from './mfa.service';
import { mfaCodeSchema } from './auth.dto';
import { SessionCookiesService } from './session-cookies.service';
import { SessionService } from './session.service';
import { RequiresSudo } from './sudo.guard';

/**
 * `/auth/mfa/*` — TOTP enrolment, the login challenge, and teardown
 * (PLAN.md §16 day 5, §8.3).
 *
 * Which routes tolerate a half-authenticated session matters here. A session
 * that owes a second factor can reach exactly the endpoints needed to satisfy
 * it, and nothing else; `@AllowsMfaPending()` marks those, and `SessionGuard`
 * refuses the rest.
 */
@ApiTags('auth')
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly cookies: SessionCookiesService,
  ) {}

  @Get()
  @AllowsMfaPending()
  @ApiOperation({
    summary: 'Multi-factor authentication status for the current user',
    description:
      'Reports whether MFA is on, whether an enrolment is half-finished, how many recovery codes remain, and whether the user is obliged to have MFA at all.',
  })
  async status(@CurrentUser() user: AuthenticatedUser): Promise<MfaStatus> {
    return this.mfa.status(user.id);
  }

  @Post('enrol')
  @AllowsMfaPending()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Begin TOTP enrolment',
    description:
      'Generates a shared secret and returns it with an otpauth:// URI for a QR code. MFA is not yet active: it is turned on only once a code from this secret has been verified, so an unscanned QR cannot lock the account out.',
  })
  async beginEnrolment(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ secret: string; provisioningUri: string }> {
    if (user.mfaEnabled) {
      // Re-enrolling would silently invalidate a working authenticator.
      // Disabling first is an explicit, second-factor-protected act.
      throw new BadRequestException(
        'multi-factor authentication is already enabled; disable it before enrolling again',
      );
    }

    return this.mfa.beginEnrolment({ id: user.id, email: user.email });
  }

  @Post('enrol/confirm')
  @AllowsMfaPending()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm TOTP enrolment and receive recovery codes',
    description:
      'Verifies a code from the pending secret, turns MFA on, and returns ten single-use recovery codes. The codes are shown exactly once and stored only as hashes.',
  })
  @ApiResponse({ status: 200, description: 'MFA enabled; recovery codes returned once.' })
  @ApiResponse({ status: 401, description: 'The code did not verify.' })
  async confirmEnrolment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ recoveryCodes: string[] }> {
    const { code } = parseBody(mfaCodeSchema, body);

    const completed = await this.mfa.completeEnrolment(user.id, code);
    if (completed === null) {
      throw new UnauthorizedException('that code did not verify');
    }

    // Enrolling satisfies the obligation that was holding this session back,
    // and is a privilege change, so §8.3 calls for a rotated session id.
    await this.satisfyFactorAndRotate(request, response);

    return { recoveryCodes: completed.recoveryCodes };
  }

  @Post('challenge')
  @AllowsMfaPending()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Answer the second-factor challenge for the current session',
    description:
      'Accepts either a six-digit TOTP code or a recovery code. On success the session becomes fully authenticated and its id is rotated.',
  })
  @ApiResponse({ status: 200, description: 'The factor was accepted.' })
  @ApiResponse({ status: 401, description: 'The code did not verify.' })
  async challenge(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ChallengeResponse> {
    const { code } = parseBody(mfaCodeSchema, body);

    const result = await this.mfa.verifySecondFactor(user.id, code);
    if (!result.valid) {
      throw new UnauthorizedException('that code did not verify');
    }

    await this.satisfyFactorAndRotate(request, response);

    return {
      method: result.method,
      ...(result.method === 'recovery_code'
        ? { recoveryCodesRemaining: result.recoveryCodesRemaining }
        : {}),
    };
  }

  @Delete()
  @RequiresSudo()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Disable multi-factor authentication',
    description:
      'Requires a currently valid second factor as well as recent re-authentication. Destroys the stored secret and every recovery code.',
  })
  @ApiResponse({ status: 204, description: 'MFA disabled.' })
  @ApiResponse({ status: 401, description: 'The code did not verify.' })
  @ApiResponse({
    status: 403,
    description: 'Recent re-authentication required, or MFA is obliged.',
  })
  async disable(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown): Promise<void> {
    const { code } = parseBody(mfaCodeSchema, body);

    // Someone required to have MFA cannot opt out of it. Without this an org
    // admin could strip the protection §8.3 makes mandatory for their role.
    const obligation = await this.mfa.obligationFor(user.id);
    if (obligation.required) {
      throw new BadRequestException(
        'multi-factor authentication is required for your role and cannot be disabled',
      );
    }

    const disabled = await this.mfa.disable(user.id, code);
    if (!disabled) {
      throw new UnauthorizedException('that code did not verify');
    }
  }

  @Post('recovery-codes')
  @RequiresSudo()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace the recovery codes',
    description:
      'Issues ten new single-use codes and invalidates the previous set. Shown once. Requires recent re-authentication.',
  })
  async regenerateRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ recoveryCodes: string[] }> {
    if (!user.mfaEnabled) {
      throw new BadRequestException('multi-factor authentication is not enabled');
    }

    return { recoveryCodes: await this.mfa.regenerateRecoveryCodes(user.id) };
  }

  /**
   * Clears the outstanding factor and replaces the session id.
   *
   * PLAN.md §8.3 requires rotation on privilege change, and going from
   * half- to fully-authenticated is exactly that: the old id was observed
   * while the session authenticated nothing, and it must not keep working now
   * that it authenticates everything.
   *
   * The new cookies go out on this response, which the browser adopts for
   * subsequent requests, and the old id is destroyed — so a copy of it taken
   * during the challenge is already useless.
   */
  private async satisfyFactorAndRotate(request: Request, response: Response): Promise<void> {
    const session = request.session;
    if (session === undefined) {
      return;
    }

    const rotated = await this.sessions.rotate(session.id, {
      userId: session.userId,
      ip: session.ip,
      userAgent: session.userAgent,
      mfaPending: false,
      mfaPendingReason: null,
    });

    // Satisfying a second factor is a re-authentication, so it opens the sudo
    // window — §8.3 accepts "password or MFA" for that.
    await this.sessions.update(rotated.id, { lastReauthAt: Date.now() });

    this.cookies.issue(response, rotated);
  }
}

export interface ChallengeResponse {
  method: 'totp' | 'recovery_code';
  recoveryCodesRemaining?: number;
}
