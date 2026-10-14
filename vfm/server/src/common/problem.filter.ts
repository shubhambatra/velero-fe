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

    // 5xx means we did something wrong and nobody outside should see why.
    if (problem.status >= 500) {
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
