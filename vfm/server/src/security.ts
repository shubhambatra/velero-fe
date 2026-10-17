import type { INestApplication } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { requestIdMiddleware } from './common/request-id';
import type { Env } from './config/env.schema';

/**
 * Security headers and request hygiene (PLAN.md §12.1), applied from day 1
 * rather than in a later hardening phase.
 *
 * The CSP is deliberately strict: no inline scripts and no third-party
 * origins. PLAN.md §1.1 P6 forbids CDN assets outright, so there is no
 * legitimate off-origin source to allow — which also means a stored-XSS
 * attempt via agent-supplied data (§12.1 treats the agent as semi-trusted)
 * has nowhere to exfiltrate to.
 */
export function applySecurity(app: INestApplication, env: Env): void {
  app.use(requestIdMiddleware);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'"],
          // The browser talks to this origin only; SSE uses the same origin.
          'connect-src': ["'self'"],
          'base-uri': ["'none'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          'object-src': ["'none'"],
          ...(env.NODE_ENV === 'production' ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      // HSTS is meaningless over plain HTTP in dev and would poison localhost.
      strictTransportSecurity:
        env.NODE_ENV === 'production'
          ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
          : false,
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      // The API serves JSON and SSE; sniffing protection costs nothing.
      noSniff: true,
      // Hiding the framework is not security, but it removes a free hint.
      hidePoweredBy: true,
    }),
  );
}

/**
 * Maximum accepted JSON body (PLAN.md §12.1: "Cap JSON sizes").
 *
 * 1 MB is generous for every v1 endpoint — the largest realistic payload is
 * `advanced_spec_json` on a backup or restore (§5.2) — and well under the
 * 4 MB gRPC limit the agent protocol uses (§5.6).
 */
export const MAX_JSON_BODY = '1mb';

const BODY_ERRORS: Record<string, string> = {
  'entity.too.large': 'The request body is too large.',
  'entity.parse.failed': 'The request body is not valid JSON.',
  'entity.verify.failed': 'The request body could not be verified.',
  'encoding.unsupported': 'The request body uses an unsupported encoding.',
  'charset.unsupported': 'The request body uses an unsupported character set.',
  'request.aborted': 'The request was aborted.',
  'request.size.invalid': 'The request size does not match its declared length.',
};

/**
 * Mounted straight after the body parsers. Their refusals are the caller's doing (413, 400),
 * not ours, and their messages can quote the body (a JSON syntax error names the text it
 * stopped at, which may be a password). They become an `HttpException` with a fixed sentence
 * per kind, which the problem filter then renders like any other.
 */
export function bodyErrors(
  error: unknown,
  _request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const { status, statusCode, type } = (error ?? {}) as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  const code = typeof status === 'number' ? status : statusCode;
  if (typeof code === 'number' && code >= 400 && code <= 499 && typeof type === 'string') {
    next(new HttpException(BODY_ERRORS[type] ?? 'The request could not be read.', code));
    return;
  }
  next(error);
}
