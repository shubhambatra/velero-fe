import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';

import { Inject } from '@nestjs/common';

import { parseBody } from '../common/parse-body';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PlatformAlreadyInitialisedError, UsersService } from '../users/users.service';
import type { AuthenticatedUser } from './authenticated-user';
import { AuthService } from './auth.service';
import { loginSchema, setupSchema } from './auth.dto';
import { CurrentUser } from './current-user.decorator';
import { PasswordService } from './password.service';
import { Public } from './public.decorator';
import { SessionService } from './session.service';
import { SetupService } from './setup.service';

/**
 * `/auth/*` (PLAN.md §10).
 *
 * M1 day 4 covers setup, login, logout and the session projection. MFA
 * enrolment and the sudo re-auth endpoint are day 5; OIDC is day 7; the
 * sessions list and API tokens are day 9.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly setup: SetupService,
  ) {}

  @Public()
  @Get('setup')
  @ApiOperation({
    summary: 'Whether first-time setup is still available',
    description:
      'True only while no user exists. The SPA uses this to decide between the login form and the setup form.',
  })
  async setupStatus(): Promise<{ open: boolean }> {
    return { open: await this.setup.isOpen() };
  }

  @Public()
  @Post('setup')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create the first platform administrator',
    description:
      'Consumes the one-time token printed to the logs on first start. Closes permanently once a user exists; there is no open self-signup.',
  })
  @ApiResponse({ status: 201, description: 'The administrator was created and is signed in.' })
  @ApiResponse({
    status: 401,
    description: 'The token is missing, wrong, expired or already used.',
  })
  @ApiResponse({ status: 422, description: 'The password does not meet the policy.' })
  async createFirstAdmin(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: AuthenticatedUser }> {
    const input = parseBody(setupSchema, body);

    // Checked before the token is consumed, so a password that fails policy
    // does not burn the operator's one token.
    const problems = this.passwords.validate(input.password, { email: input.email });
    if (problems.length > 0) {
      throw new UnprocessableEntityException({ message: problems });
    }

    if (!(await this.setup.consumeToken(input.token))) {
      throw new UnauthorizedException('invalid or expired setup token');
    }

    const passwordHash = await this.passwords.hash(input.password);

    let user: AuthenticatedUser;
    try {
      user = await this.users.createFirstPlatformAdmin({
        email: input.email,
        name: input.name ?? null,
        passwordHash,
      });
    } catch (error: unknown) {
      if (error instanceof PlatformAlreadyInitialisedError) {
        // Two requests raced, or a token survived an earlier setup.
        throw new UnauthorizedException('invalid or expired setup token');
      }
      throw error;
    }

    this.logger.warn(`first platform administrator created: ${user.id}`);

    await this.startSession(user, request, response);
    return { user };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiResponse({ status: 200, description: 'Signed in; a session cookie is set.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({
    status: 429,
    description: 'Too many attempts. Retry-After gives the wait in seconds.',
  })
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: AuthenticatedUser; mfaRequired: boolean }> {
    const input = parseBody(loginSchema, body);

    const result = await this.auth.login({
      email: input.email,
      password: input.password,
      ip: clientIp(request),
    });

    if (!result.ok) {
      if (result.reason === 'invalid_credentials') {
        // One message for an unknown email, a wrong password and a disabled
        // account alike (PLAN.md §8.3 brute-force protection).
        throw new UnauthorizedException('invalid email or password');
      }

      response.setHeader('Retry-After', result.retryAfterSeconds.toString());
      throw new TooManyRequestsException(
        result.reason === 'account_locked'
          ? 'too many failed attempts for this account; try again later'
          : 'too many failed attempts from this address; try again later',
      );
    }

    await this.startSession(result.user, request, response, result.mfaRequired);

    return { user: result.user, mfaRequired: result.mfaRequired };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out of the current session' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const session = request.session;
    if (session !== undefined) {
      await this.sessions.destroy(session.id);
    }
    this.clearCookies(response);
  }

  @Delete('sessions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign out everywhere',
    description:
      'Revokes every other session for the current user, keeping this one. PLAN.md §8.3.',
  })
  async signOutEverywhere(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<{ revoked: number }> {
    const currentSessionId = request.session?.id;
    const revoked = await this.sessions.destroyAllForUser(
      user.id,
      currentSessionId === undefined ? {} : { except: currentSessionId },
    );
    return { revoked };
  }

  @Get('me')
  @ApiOperation({ summary: 'The currently authenticated user' })
  me(@CurrentUser() user: AuthenticatedUser): { user: AuthenticatedUser } {
    return { user };
  }

  private async startSession(
    user: AuthenticatedUser,
    request: Request,
    response: Response,
    mfaPending = false,
  ): Promise<void> {
    const created = await this.sessions.create({
      userId: user.id,
      ip: clientIp(request),
      userAgent: request.header('user-agent') ?? '',
      mfaPending,
    });

    response.cookie(SessionService.COOKIE, created.id, this.sessionCookieOptions());
    response.cookie(SessionService.CSRF_COOKIE, created.csrfToken, this.csrfCookieOptions());
  }

  private clearCookies(response: Response): void {
    // Same attributes as when set, or the browser keeps the original cookie.
    response.clearCookie(SessionService.COOKIE, this.sessionCookieOptions());
    response.clearCookie(SessionService.CSRF_COOKIE, this.csrfCookieOptions());
  }

  /** PLAN.md §8.3: httpOnly, Secure, SameSite=Lax. */
  private sessionCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      // Secure would make the cookie unusable over plain-HTTP localhost, so it
      // follows the environment. Every real deployment is TLS-only (§12.1).
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SessionService.ABSOLUTE_TTL_MS,
    };
  }

  /**
   * The CSRF cookie is intentionally **not** httpOnly: the SPA has to read it
   * to echo it back in the header. It is not a credential on its own — it is
   * only accepted alongside a session cookie it must match.
   */
  private csrfCookieOptions(): CookieOptions {
    return {
      httpOnly: false,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SessionService.ABSOLUTE_TTL_MS,
    };
  }
}

/**
 * Nest has no built-in 429 exception.
 *
 * Carries the problem+json shape the global filter produces, so a throttled
 * caller gets the same error envelope as every other failure (§10).
 */
class TooManyRequestsException extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.message = message;
  }

  override getStatus(): number {
    return HttpStatus.TOO_MANY_REQUESTS;
  }
}

/**
 * The caller's address, for rate limiting.
 *
 * Express only populates `req.ip` from `X-Forwarded-For` when `trust proxy` is
 * configured, which `main.ts` does explicitly. Taking the header
 * unconditionally would let any caller spoof their way out of an IP rate limit
 * by setting it themselves.
 */
function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}
