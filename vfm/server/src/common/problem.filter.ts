import { ThrottledException } from './throttled.exception';
import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { redact } from './redact';
import { REQUEST_ID_HEADER, requestIdOf } from './request-id';

/**
 * RFC 9457 `application/problem+json` error responses (PLAN.md §10).
 *
 * Every error the API returns has the same shape, carries the request id so a
 * user can quote it in a support request, and never leaks an internal message
 * for an unexpected failure — the detail is logged server-side instead
 * (PLAN.md §12.1).
 */
export interface ApiProblem {
  /** URI reference identifying the problem type. */
  type: string;
  /** Short, human-readable summary, stable for a given `type`. */
  title: string;
  status: number;
  /** Explanation specific to this occurrence. */
  detail?: string | undefined;
  /** URI reference identifying this specific occurrence. */
  instance?: string | undefined;
  /**
   * Correlation id, also sent as a header. Absent only if the request-id
   * middleware did not run, which should not happen in a served request.
   */
  requestId?: string | undefined;
  /** Field-level validation failures, when the status is 422. */
  errors?: { path: string; message: string }[] | undefined;
  /** Step-up marker (RFC 9457 extension member): re-authenticate, then retry. */
  sudoRequired?: true | undefined;
  /** The session still owes a second factor; see `mfaPendingReason`. */
  mfaRequired?: true | undefined;
  mfaPendingReason?: 'enrolment' | 'challenge' | undefined;
}

/**
 * Extension members that guards attach to an exception body and that clients
 * act on. An allow-list, not a spread: an exception body is not a response
 * contract, and copying it wholesale is how internals end up on the wire.
 */
function extensionMembers(body: unknown): Partial<ApiProblem> {
  if (body === null || typeof body !== 'object') {
    return {};
  }
  const source = body as Record<string, unknown>;
  const out: Partial<ApiProblem> = {};
  if (source.sudoRequired === true) {
    out.sudoRequired = true;
  }
  if (source.mfaRequired === true) {
    out.mfaRequired = true;
  }
  if (source.mfaPendingReason === 'enrolment' || source.mfaPendingReason === 'challenge') {
    out.mfaPendingReason = source.mfaPendingReason;
  }
  return out;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Problem `type` URIs are documented, so they must be stable identifiers. */
export function problemTypeFor(status: number): string {
  const slug = (
    Object.entries(HttpStatus).find(
      // HttpStatus values are numbers; `status` arrives as a plain number.
      ([, value]) => Number(value) === status,
    )?.[0] ?? 'INTERNAL_SERVER_ERROR'
  )
    .toLowerCase()
    .replace(/_/g, '-');
  return `https://vfm.io/problems/${slug}`;
}

@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const problem = this.toProblem(exception, request);

    if (problem.status === 503 && !(exception instanceof HttpException)) {
      // An outage is the dependency's news, not a bug: one line, no stack, and /readyz says the rest.
      this.logger.warn(
        { requestId: problem.requestId, path: request.url, method: request.method },
        'a dependency is unavailable',
      );
    } else if (problem.status >= 500) {
      // 5xx means we did something wrong and nobody outside should see why.
      this.logger.error(
        {
          requestId: problem.requestId,
          path: request.url,
          method: request.method,
          err: redact(exception),
        },
        'unhandled exception',
      );
    }

    if (problem.status === 503 && !(exception instanceof HttpException)) {
      response.setHeader('Retry-After', '5');
    }

    if (exception instanceof ThrottledException) {
      response.setHeader(
        'Retry-After',
        Math.max(1, Math.ceil(exception.retryAfterSeconds)).toString(),
      );
    }

    response
      .status(problem.status)
      .setHeader('Content-Type', PROBLEM_CONTENT_TYPE)
      .setHeader(REQUEST_ID_HEADER, problem.requestId ?? '')
      .json(problem);
  }

  private toProblem(exception: unknown, request: Request): ApiProblem {
    const requestId = requestIdOf(request);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // Nest puts either a string or an object here depending on how the
      // exception was constructed; normalise both into one shape.
      const detail = typeof body === 'string' ? body : extractMessage(body);

      return {
        type: problemTypeFor(status),
        title: statusTitle(status),
        status,
        ...(detail === undefined ? {} : { detail }),
        ...extensionMembers(body),
        instance: request.url,
        requestId,
      };
    }

    if (isDependencyOutage(exception)) {
      return {
        type: problemTypeFor(HttpStatus.SERVICE_UNAVAILABLE),
        title: statusTitle(HttpStatus.SERVICE_UNAVAILABLE),
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'A service this one depends on is unavailable. Try again shortly.',
        instance: request.url,
        requestId,
      };
    }

    return {
      type: problemTypeFor(HttpStatus.INTERNAL_SERVER_ERROR),
      title: statusTitle(HttpStatus.INTERNAL_SERVER_ERROR),
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'An unexpected error occurred.',
      instance: request.url,
      requestId,
    };
  }
}

/**
 * Whether an error means PostgreSQL or Redis could not be reached, as opposed to a bug. The two look
 * alike from outside (a 500 with nothing to act on), but a client and a load balancer should retry
 * the one and not the other. Matched on the error's name, code and message so no driver is imported here.
 */
export function isDependencyOutage(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = error; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      /^(ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|57P01|57P02|57P03|08\w+)$/.test(code)
    ) {
      return true;
    }
    if (
      e.name === 'MaxRetriesPerRequestError' ||
      e.name === 'PrismaClientInitializationError' ||
      /Stream isn't writeable|Connection is closed|Connection terminated|timeout exceeded when trying to connect|Can't reach database|ECONNREFUSED|ECONNRESET/i.test(
        e.message,
      )
    ) {
      return true;
    }
  }
  return false;
}

function extractMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string') {
    return message;
  }
  if (Array.isArray(message)) {
    return message.filter((part): part is string => typeof part === 'string').join('; ');
  }
  return undefined;
}

function statusTitle(status: number): string {
  const name = Object.entries(HttpStatus).find(([, value]) => Number(value) === status)?.[0];
  if (name === undefined) {
    return 'Error';
  }
  return name
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
