import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import { type ApiProblem, PROBLEM_CONTENT_TYPE, ProblemExceptionFilter } from './problem.filter';
import { REQUEST_ID_HEADER } from './request-id';

function catchException(exception: unknown): {
  status: number;
  body: ApiProblem;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  let status = 0;
  let body: ApiProblem | undefined;

  const response = {
    status: (code: number) => {
      status = code;
      return response;
    },
    setHeader: (name: string, value: string) => {
      headers[name] = value;
      return response;
    },
    json: (payload: ApiProblem) => {
      body = payload;
      return response;
    },
  };

  const request = { url: '/api/v1/clusters', method: 'POST', requestId: 'req-12345678' };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  };

  new ProblemExceptionFilter().catch(
    exception,
    host as unknown as Parameters<ProblemExceptionFilter['catch']>[1],
  );

  if (body === undefined) {
    throw new Error('filter did not write a response body');
  }
  return { status, body, headers };
}

describe('ProblemExceptionFilter', () => {
  beforeAll(() => {
    // The filter logs 5xx server-side on purpose; keep the test output clean.
    Logger.overrideLogger(false);
  });

  it('renders an HttpException as RFC 9457 problem+json', () => {
    const { status, body, headers } = catchException(new NotFoundException('cluster not found'));

    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(headers['Content-Type']).toBe(PROBLEM_CONTENT_TYPE);
    expect(body).toStrictEqual({
      type: 'https://vfm.io/problems/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'cluster not found',
      instance: '/api/v1/clusters',
      requestId: 'req-12345678',
    });
  });

  it('carries the request id in both the body and the header', () => {
    const { body, headers } = catchException(new ForbiddenException());

    expect(body.requestId).toBe('req-12345678');
    expect(headers[REQUEST_ID_HEADER]).toBe('req-12345678');
  });

  it('flattens the array of messages a validation failure produces', () => {
    const { body } = catchException(
      new BadRequestException(['name must be a string', 'ttl must match a duration']),
    );

    expect(body.status).toBe(400);
    expect(body.detail).toBe('name must be a string; ttl must match a duration');
  });

  it('does not leak the message of an unexpected error', () => {
    // PLAN.md §12.1: an internal failure must not describe itself to a caller.
    // It is still logged server-side, which is what the suppressed logger
    // above would otherwise print.
    const { status, body } = catchException(
      new Error('connect ECONNREFUSED postgres://vfm:hunter2@db:5432'),
    );

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.detail).toBe('An unexpected error occurred.');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('treats a thrown non-Error the same way', () => {
    const { status, body } = catchException('something odd');

    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.detail).toBe('An unexpected error occurred.');
  });

  it('uses a stable type URI per status, since the types are documented', () => {
    expect(catchException(new ForbiddenException()).body.type).toBe(
      'https://vfm.io/problems/forbidden',
    );
    expect(catchException(new BadRequestException()).body.type).toBe(
      'https://vfm.io/problems/bad-request',
    );
  });
});
