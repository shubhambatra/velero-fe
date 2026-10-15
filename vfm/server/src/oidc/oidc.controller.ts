import { Controller, Get, Logger, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';

import { MfaService } from '../auth/mfa.service';
import { Public } from '../auth/public.decorator';
import { SessionCookiesService } from '../auth/session-cookies.service';
import { SessionService } from '../auth/session.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { callbackQuerySchema } from './oidc.dto';
import { OidcLoginError, OidcLoginService } from './oidc-login.service';
import { OidcProvidersService } from './oidc-providers.service';

/** The browser-facing half of OIDC sign-in (PLAN.md §8.3, §10 `/auth/*`). */
@ApiTags('auth')
@Controller('auth/oidc')
export class OidcController {
  private readonly logger = new Logger(OidcController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly login: OidcLoginService,
    private readonly providers: OidcProvidersService,
    private readonly sessions: SessionService,
    private readonly cookies: SessionCookiesService,
    private readonly mfa: MfaService,
  ) {}

  @Public()
  @Get('providers')
  @ApiOperation({
    summary: 'SSO buttons for an org’s sign-in page',
    description: 'Public. Returns only id and display name of enabled providers.',
  })
  async list(@Query('org') org: string | undefined) {
    if (org === undefined || org === '' || org.length > 64) {
      return { providers: [] };
    }
    return { providers: await this.providers.publicForOrgSlug(org.toLowerCase()) };
  }

  @Public()
  @Get(':providerId/start')
  @ApiOperation({ summary: 'Begin SSO: redirects to the identity provider' })
  async start(@Param('providerId') providerId: string, @Res() response: Response): Promise<void> {
    let started;
    try {
      started = await this.login.start(providerId);
    } catch (error: unknown) {
      if (error instanceof OidcLoginError) {
        throw new NotFoundException('provider not found');
      }
      throw error;
    }

    response.cookie(OidcLoginService.STATE_COOKIE, started.state, {
      httpOnly: true,
      // Lax, not Strict: the callback is a cross-site top-level GET, and a
      // Strict cookie would not be sent on it.
      sameSite: 'lax',
      secure: this.env.NODE_ENV === 'production',
      path: '/api/v1/auth/oidc',
      maxAge: OidcLoginService.STATE_COOKIE_MAX_AGE_MS,
    });
    response.redirect(302, started.url);
  }

  @Public()
  @Get('callback')
  @ApiOperation({
    summary: 'SSO callback',
    description:
      'Always answers with a redirect to the web app. Every failure carries the same `sso=failed` marker; the reason is logged, not disclosed.',
  })
  async callback(
    @Query() query: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const web = this.env.PUBLIC_URL;
    const failed = (): void => {
      response.clearCookie(OidcLoginService.STATE_COOKIE, { path: '/api/v1/auth/oidc' });
      response.redirect(302, `${web}/login?sso=failed`);
    };

    const parsed = callbackQuerySchema.safeParse(query);
    if (!parsed.success) {
      failed();
      return;
    }

    const cookieState = (request.cookies as Record<string, unknown> | undefined)?.[
      OidcLoginService.STATE_COOKIE
    ];

    try {
      const result = await this.login.complete({
        callbackUrl: new URL(
          `${this.login.redirectUri}?${new URLSearchParams(
            Object.entries(parsed.data).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ).toString()}`,
        ),
        state: parsed.data.state,
        cookieState: typeof cookieState === 'string' ? cookieState : undefined,
        idpError: parsed.data.error,
      });

      // A new Owner or Admin owes MFA too: the IdP's authentication is not
      // assumed to include a second factor (PLAN.md §8.3).
      const obligation = await this.mfa.obligationFor(result.user.id);
      const reason = result.user.mfaEnabled
        ? 'challenge'
        : obligation.required
          ? 'enrolment'
          : null;

      const created = await this.sessions.create({
        userId: result.user.id,
        ip: request.ip ?? request.socket.remoteAddress ?? 'unknown',
        userAgent: request.header('user-agent') ?? '',
        mfaPending: reason !== null,
        mfaPendingReason: reason,
      });
      this.cookies.issue(response, created);
      response.clearCookie(OidcLoginService.STATE_COOKIE, { path: '/api/v1/auth/oidc' });
      response.redirect(302, reason === null ? `${web}/` : `${web}/mfa?reason=${reason}`);
    } catch (error: unknown) {
      if (error instanceof OidcLoginError) {
        this.logger.warn(`sso refused: ${error.reason}`);
        failed();
        return;
      }
      throw error;
    }
  }
}
