import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Injectable, Logger } from '@nestjs/common';

import type { AuthenticatedUser } from './authenticated-user';
import { MailService } from '../mail/mail.service';
import { LdapService } from './ldap.service';
import { LoginThrottleService } from './login-throttle.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import type { MfaPendingReason } from './session.service';
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
    private readonly mfa: MfaService,
    private readonly mail: MailService,
    private readonly ldap: LdapService,
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
    let passwordMatches = await this.passwords.verify(hash, input.password);

    // A directory password counts too, for an account that exists here. The directory is asked
    // for unknown addresses as well, so the work does not reveal which accounts exist.
    if (!passwordMatches && this.ldap.enabled) {
      const directoryMatches = await this.ldap.verify(email, input.password);
      passwordMatches = directoryMatches && candidate !== null;
    }

    const usable = candidate !== null && candidate.disabledAt === null && passwordMatches;

    if (!usable) {
      const outcome = await this.throttle.recordFailure(identity);
      if (outcome.lockedNow) {
        this.logger.warn(`account lockout reached for a login attempt from ${input.ip}`);
        // PLAN.md §8.3: "lockout notification email". Only for a real
        // account, and deliberately not awaited: an awaited send would make
        // the response slower exactly when the account exists, which is an
        // enumeration signal an unknown address cannot produce. A mail
        // failure is logged and never changes the login response.
        if (candidate !== null && candidate.disabledAt === null) {
          void this.notifyLockout(candidate.email, input.ip);
        }
      }
      return { ok: false, reason: 'invalid_credentials' };
    }

    await this.throttle.recordSuccess(identity);

    // Opportunistic upgrade: if the stored hash predates the current argon2
    // parameters, replace it now that the plaintext is in hand and verified.
    if (
      candidate.passwordHash !== null &&
      this.passwords.needsRehash(candidate.passwordHash) &&
      (await this.passwords.verify(candidate.passwordHash, input.password))
    ) {
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

    // A password alone is never enough for anyone who has a second factor, or
    // who owes one by role or org policy (PLAN.md §8.3). The session is issued
    // either way — the challenge has to be answerable — but SessionGuard
    // refuses it everywhere except the MFA endpoints until this clears.
    const mfaPendingReason = await this.secondFactorObligation(candidate.id, candidate.mfaEnabled);

    return {
      ok: true,
      user,
      mfaPendingReason,
    };
  }

  private async notifyLockout(email: string, ip: string): Promise<void> {
    const minutes = Math.round(LoginThrottleService.ACCOUNT_LOCKOUT_SECONDS / 60);
    try {
      await this.mail.send({
        to: email,
        subject: 'Your account was temporarily locked',
        text:
          `There were ${LoginThrottleService.ACCOUNT_MAX_FAILURES.toString()} failed sign-in attempts ` +
          `on your account, most recently from ${ip}.\n\n` +
          `Sign-in is paused for ${minutes.toString()} minutes. If this was you, wait and try again. ` +
          `If it was not, your password may be under attack: change it after the lock lifts and ` +
          `consider enabling multi-factor authentication.\n`,
      });
    } catch (error: unknown) {
      this.logger.warn(
        `could not send the lockout notification: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /**
   * What the user still owes after a correct password.
   *
   * `challenge` when they have a factor to present; `enrolment` when they are
   * required to have one and do not yet; null when nothing is outstanding.
   */
  private async secondFactorObligation(
    userId: string,
    mfaEnabled: boolean,
  ): Promise<MfaPendingReason | null> {
    if (mfaEnabled) {
      return 'challenge';
    }

    const obligation = await this.mfa.obligationFor(userId);
    return obligation.required ? 'enrolment' : null;
  }
}

export interface LoginInput {
  email: string;
  password: string;
  ip: string;
}

export type LoginResult =
  | { ok: true; user: AuthenticatedUser; mfaPendingReason: MfaPendingReason | null }
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'account_locked' | 'ip_throttled'; retryAfterSeconds: number };
