import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Injectable, Logger } from '@nestjs/common';

import type { AuthenticatedUser } from './authenticated-user';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import { normalizeEmail, UsersService } from '../users/users.service';

/**
 * The local login path (PLAN.md §8.3).
 *
 * The ordering here is the security-relevant part:
 *
 *  1. throttle check — a locked account costs no password hashing at all,
 *  2. progressive delay — applied *before* the result is known, so its
 *     duration cannot be read as a signal about the account,
 *  3. user lookup and password verify — always both, even for an unknown
 *     email, so response time does not reveal whether an account exists,
 *  4. one failure reason for every failure.
 *
 * Step 3 matters more than it looks. The naive implementation returns early
 * when the email is unknown, which makes account enumeration a timing
 * measurement: argon2id at 19 MiB takes tens of milliseconds, and skipping it
 * is trivially observable. So an unknown email is verified against a dummy
 * hash and discarded.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * A real argon2id hash of a random value, used as the comparison target when
   * no account matches so an unknown email costs the same work as a real one.
   * Nothing can ever match it.
   *
   * Computed lazily and memoised rather than in the constructor: doing async
   * work during construction is fragile — parameter properties are not
   * reliably assigned at that point across TypeScript transpilers, which broke
   * startup under tsx while passing under the test runner's SWC config.
   */
  private dummyHashPromise: Promise<string> | undefined;

  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly throttle: LoginThrottleService,
  ) {}

  private dummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.passwords.hash(`unused-${randomBytes(16).toString('hex')}`);
    return this.dummyHashPromise;
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const identity = { email, ip: input.ip };

    const decision = await this.throttle.check(identity);
    if (!decision.allowed) {
      return {
        ok: false,
        reason: decision.reason,
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    }

    // Before the outcome is known, so its duration says nothing about it.
    if (decision.delayMs > 0) {
      await delay(decision.delayMs);
    }

    const candidate = await this.users.findForLogin(email);

    // Spend the same work whether or not the account exists, and whether or
    // not it has a password set (an OIDC-only user has a null hash, §9).
    const hash = candidate?.passwordHash ?? (await this.dummyHash());
    const passwordMatches = await this.passwords.verify(hash, input.password);

    const usable =
      candidate !== null &&
      candidate.passwordHash !== null &&
      candidate.disabledAt === null &&
      passwordMatches;

    if (!usable) {
      const outcome = await this.throttle.recordFailure(identity);
      if (outcome.lockedNow) {
        // PLAN.md §8.3 also calls for a lockout notification email. The
        // mailer lands with org invites in M1 day 6; until then this is the
        // record of the event. Tracked under Deferred in docs/PROGRESS.md.
        this.logger.warn(`account lockout reached for a login attempt from ${input.ip}`);
      }
      return { ok: false, reason: 'invalid_credentials' };
    }

    await this.throttle.recordSuccess(identity);

    // Opportunistic upgrade: if the stored hash predates the current argon2
    // parameters, replace it now that the plaintext is in hand and verified.
    if (candidate.passwordHash !== null && this.passwords.needsRehash(candidate.passwordHash)) {
      const rehashed = await this.passwords.hash(input.password);
      await this.users.updatePasswordHash(candidate.id, rehashed);
    }

    await this.users.recordLogin(candidate.id);

    const user: AuthenticatedUser = {
      id: candidate.id,
      email: candidate.email,
      name: candidate.name,
      isPlatformAdmin: candidate.isPlatformAdmin,
      mfaEnabled: candidate.mfaEnabled,
    };

    return {
      ok: true,
      user,
      // MFA enrolment and the challenge arrive in M1 day 5. A user with MFA
      // enabled must not be fully authenticated by a password alone, so the
      // session is marked pending and the guard will refuse to treat it as
      // authenticated once day 5 wires that in.
      mfaRequired: candidate.mfaEnabled,
    };
  }
}

export interface LoginInput {
  email: string;
  password: string;
  ip: string;
}

export type LoginResult =
  | { ok: true; user: AuthenticatedUser; mfaRequired: boolean }
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'account_locked' | 'ip_throttled'; retryAfterSeconds: number };
