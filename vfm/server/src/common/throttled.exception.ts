import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 429 that says when to come back. The problem filter turns `retryAfterSeconds` into the
 * `Retry-After` header, so a client (and the UI) can wait instead of hammering.
 */
export class ThrottledException extends HttpException {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
