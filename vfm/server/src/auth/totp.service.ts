import { Injectable } from '@nestjs/common';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';

import { PRODUCT_NAME } from '@vfm/shared';

/**
 * TOTP, the second factor required by PLAN.md §8.3.
 *
 * ## Verification window
 *
 * One step either side of now (±30 s). Phone clocks drift and people start
 * typing a code just before it rolls over; a zero-tolerance window produces
 * support tickets rather than security. Wider than one step starts to matter,
 * because a shoulder-surfed code stays usable for as long as the window is
 * open.
 *
 * ## Replay
 *
 * A TOTP code is valid for its whole step, so without extra state the same
 * six digits can be submitted twice. {@link verify} returns the time step the
 * code belonged to, and the caller records the highest step already accepted
 * for that user and passes it back as `afterTimeStep`. Each code is then
 * usable exactly once. This is why `verify` reports the step rather than just
 * a boolean.
 */
@Injectable()
export class TotpService {
  /** 20 bytes = 160 bits, the RFC 4226 recommendation. */
  private static readonly SECRET_BYTES = 20;

  /** Seconds per step. 30 is what every authenticator app assumes. */
  static readonly PERIOD_SECONDS = 30;

  /**
   * Tolerance either side of now, **in seconds** — not in steps.
   *
   * otplib's `epochTolerance` is a number of seconds, so passing 1 here would
   * allow a single second of drift rather than the intended step. One full
   * period each way is the standard window.
   */
  private static readonly TOLERANCE_SECONDS = TotpService.PERIOD_SECONDS;

  /** Generates a new base32 shared secret for enrolment. */
  generateSecret(): string {
    return generateSecret({ length: TotpService.SECRET_BYTES });
  }

  /**
   * The `otpauth://` URI an authenticator app consumes, usually via a QR code.
   *
   * The label carries the account's email so a user with several accounts can
   * tell the entries apart, and the issuer is the product name so the app
   * groups them.
   */
  provisioningUri(secret: string, email: string): string {
    return generateURI({
      strategy: 'totp',
      issuer: PRODUCT_NAME,
      label: email,
      secret,
      period: TotpService.PERIOD_SECONDS,
    });
  }

  /**
   * Checks a submitted code.
   *
   * `afterTimeStep` rejects a code from a step already used, which is what
   * makes a code single-use. Pass the value stored from the last successful
   * verification for this user.
   */
  verify(options: { secret: string; token: string; afterTimeStep?: number }): TotpVerification {
    // Authenticator apps show the code in groups; people paste it with the
    // space in. Non-digits are stripped before the length check so a correct
    // code is not rejected over formatting.
    const token = options.token.replace(/\D/g, '');
    if (token.length !== 6) {
      return { valid: false };
    }

    const result = verifySync({
      secret: options.secret,
      token,
      epochTolerance: TotpService.TOLERANCE_SECONDS,
      ...(options.afterTimeStep === undefined ? {} : { afterTimeStep: options.afterTimeStep }),
    });

    if (!result.valid) {
      return { valid: false };
    }

    // otplib's VerifyResult is a union over the TOTP and HOTP strategies, and
    // only the TOTP branch carries a time step. We always verify TOTP, so this
    // narrows rather than guards against a real case — but asserting it keeps
    // the replay protection from silently becoming a no-op if the strategy
    // ever changes.
    if (!('timeStep' in result)) {
      return { valid: false };
    }

    return { valid: true, timeStep: result.timeStep };
  }

  /**
   * Generates a code for a chosen moment.
   *
   * Only used by tests and by the dev seed script — never on a request path,
   * since the server has no business producing a user's second factor.
   *
   * `stepOffset` shifts the moment by whole periods, which tests need because
   * replay protection makes each step single-use: after one code has been
   * accepted, the next assertion has to use the *following* step rather than
   * waiting 30 seconds for it.
   */
  generateForTesting(secret: string, stepOffset = 0): string {
    if (stepOffset === 0) {
      return generateSync({ secret });
    }

    // otplib's `epoch` is in **seconds**, not milliseconds. Passing
    // Date.now() here generates a code for a time ~56 000 years away, which
    // simply fails to verify.
    const epochSeconds = Math.floor(Date.now() / 1_000) + stepOffset * TotpService.PERIOD_SECONDS;
    return generateSync({ secret, epoch: epochSeconds });
  }
}

export type TotpVerification = { valid: false } | { valid: true; timeStep: number };
