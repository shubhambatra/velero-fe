import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { PRODUCT_NAME, PRODUCT_SLUG } from '@vfm/shared';

import { RedisService } from '../redis/redis.service';
import { UsersService } from '../users/users.service';

/**
 * The one-time bootstrap of the first platform administrator (PLAN.md §16
 * day 4: "Registration of the first platform admin via a one-time setup token
 * printed in the logs on first start. No open self-signup.").
 *
 * Why a token in the logs rather than a default password or an open signup
 * page: whoever can read the control plane's logs already has operational
 * control of it, so that channel proves possession of the deployment without
 * introducing a credential that exists before anyone claims it. A default
 * password would be live on every install that never changed it.
 *
 * Properties:
 *   - issued **only** while the `users` table is empty,
 *   - stored as a SHA-256 digest, so the log line is the only copy of the
 *     plaintext and a Redis dump does not yield a usable token,
 *   - 24 h TTL, matching the cluster bootstrap token in §5.1,
 *   - burned atomically on use, and the whole flow then closes permanently
 *     because a user now exists.
 *
 * The digest lives in Redis rather than Postgres so it leaves no row behind
 * after setup, and so a forgotten token cannot be resurrected from a database
 * backup.
 */
@Injectable()
export class SetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SetupService.name);

  static readonly TOKEN_TTL_SECONDS = 24 * 60 * 60;
  private static readonly KEY = `${PRODUCT_SLUG}:setup:token`;

  constructor(
    private readonly redis: RedisService,
    private readonly users: UsersService,
  ) {}

  /**
   * Issues a setup token on start if, and only if, no user exists.
   *
   * Runs on every boot: if the previous token expired unused, or Redis was
   * cleared, the operator gets a fresh one rather than an install they can
   * never claim.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!(await this.users.isEmpty())) {
      return;
    }

    const token = randomBytes(32).toString('base64url');
    await this.redis.connection.set(
      SetupService.KEY,
      digest(token),
      'EX',
      SetupService.TOKEN_TTL_SECONDS,
    );

    // Deliberately a multi-line banner at warn level: this is the one secret
    // the product ever writes to its own logs, and it must not scroll past
    // unnoticed among request lines.
    this.logger.warn(
      [
        '',
        '='.repeat(72),
        `${PRODUCT_NAME} has no users yet. Create the first administrator with:`,
        '',
        `  curl -sS -X POST http://localhost:3000/api/v1/auth/setup \\`,
        `    -H 'Content-Type: application/json' \\`,
        `    -d '{"token":"${token}","email":"you@example.com","password":"<at least 12 characters>"}'`,
        '',
        `This token is valid for 24 hours, works exactly once, and is the only`,
        `copy — it is stored hashed. A new one is printed on restart while no`,
        `user exists.`,
        '='.repeat(72),
        '',
      ].join('\n'),
    );
  }

  /** Whether the setup flow is still open, for the status endpoint. */
  async isOpen(): Promise<boolean> {
    return this.users.isEmpty();
  }

  /**
   * Validates and burns a setup token.
   *
   * `GETDEL` makes read-and-delete a single atomic operation, so two requests
   * arriving with the same token cannot both pass this check. The comparison
   * is timing-safe because the stored value is a secret-derived digest.
   */
  async consumeToken(token: string): Promise<boolean> {
    const stored = await this.redis.connection.getdel(SetupService.KEY);
    if (stored === null) {
      return false;
    }

    const expected = Buffer.from(stored, 'hex');
    const submitted = Buffer.from(digest(token), 'hex');

    if (expected.length !== submitted.length || !timingSafeEqual(expected, submitted)) {
      // A wrong token has already consumed the stored one by this point.
      // That is the safe direction: a failed guess invalidates the token and
      // the operator restarts the control plane for a new one, rather than an
      // attacker being allowed unlimited guesses against a live token.
      this.logger.warn('setup token rejected; the stored token has been invalidated');
      return false;
    }

    return true;
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
