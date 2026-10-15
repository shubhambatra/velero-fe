import { Injectable, Logger } from '@nestjs/common';

import { CryptoService, EncryptionContext } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { mfaObligationFor, type MfaObligation } from './org-mfa-policy';
import { RecoveryCodesService } from './recovery-codes.service';
import { TotpService } from './totp.service';

/**
 * MFA enrolment and verification (PLAN.md §16 day 5, §8.3).
 *
 * The shared secret lives in `users.mfa_secret_encrypted` under envelope
 * encryption (§9), so it is written and read only through {@link CryptoService}
 * and never appears in a log line, an audit entry or an API response once
 * enrolment is complete.
 *
 * Enrolment is two steps on purpose. `beginEnrolment` stores a secret with
 * `mfaEnabled` still false; `completeEnrolment` turns it on only after the
 * user has proved their authenticator holds the same secret. A one-step
 * enrolment can leave an account requiring a factor nobody can produce,
 * because the QR code was never actually scanned.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly totp: TotpService,
    private readonly recoveryCodes: RecoveryCodesService,
  ) {}

  /**
   * Generates and stores a candidate secret, returning what the user needs to
   * add it to an authenticator.
   *
   * Re-enrolling replaces any pending secret, so an abandoned attempt cannot
   * be completed later by someone who kept the earlier QR code.
   */
  async beginEnrolment(user: { id: string; email: string }): Promise<MfaEnrolment> {
    const secret = this.totp.generateSecret();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        mfaSecretEncrypted: this.crypto.encrypt(secret, EncryptionContext.userMfaSecret(user.id)),
        // Still off: the factor is not trusted until it has been proved once.
        mfaEnabled: false,
        // A fresh secret starts with a clean replay window.
        mfaLastTimeStep: null,
      },
    });

    return {
      secret,
      provisioningUri: this.totp.provisioningUri(secret, user.email),
    };
  }

  /**
   * Turns MFA on after verifying a code from the pending secret, and issues
   * the recovery codes.
   *
   * The codes are returned once and never again — the caller must show them
   * and move on. Returning them from this call rather than a separate endpoint
   * means there is no window where MFA is required and no recovery exists.
   */
  async completeEnrolment(userId: string, token: string): Promise<CompletedEnrolment | null> {
    const secret = await this.loadSecret(userId);
    if (secret === null) {
      return null;
    }

    const result = this.totp.verify({ secret, token });
    if (!result.valid) {
      return null;
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaLastTimeStep: BigInt(result.timeStep) },
    });

    const codes = await this.recoveryCodes.generate(userId);
    this.logger.log(`mfa enabled for user ${userId}`);

    return { recoveryCodes: codes };
  }

  /**
   * Verifies a second factor: a TOTP code, or a recovery code.
   *
   * Both are accepted at the same entry point because the caller — the login
   * challenge, or sudo re-auth — should not have to guess which the user has
   * to hand. A TOTP code is six digits and a recovery code is sixteen base32
   * characters, so they are told apart by shape rather than by a flag the
   * client sets.
   */
  async verifySecondFactor(userId: string, submitted: string): Promise<SecondFactorResult> {
    const trimmed = submitted.trim();

    if (/^\d{6}$/.test(trimmed.replace(/\s/g, ''))) {
      return this.verifyTotp(userId, trimmed);
    }

    const spent = await this.recoveryCodes.consume(userId, trimmed);
    if (!spent) {
      return { valid: false };
    }

    const remaining = await this.recoveryCodes.remaining(userId);
    if (remaining === 0) {
      // Worth saying out loud: the next lost phone locks the account out and
      // needs an administrator.
      this.logger.warn(`user ${userId} has used their last recovery code`);
    }

    this.logger.log(`recovery code used by user ${userId}, ${remaining.toString()} remaining`);
    return { valid: true, method: 'recovery_code', recoveryCodesRemaining: remaining };
  }

  private async verifyTotp(userId: string, token: string): Promise<SecondFactorResult> {
    const record = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecretEncrypted: true, mfaEnabled: true, mfaLastTimeStep: true },
    });

    if (record === null || !record.mfaEnabled || record.mfaSecretEncrypted === null) {
      return { valid: false };
    }

    const secret = this.decryptSecret(userId, record.mfaSecretEncrypted);
    if (secret === null) {
      return { valid: false };
    }

    const result = this.totp.verify({
      secret,
      token,
      // Rejects any step already spent, which is what stops a code being
      // replayed inside its 30-second validity.
      ...(record.mfaLastTimeStep === null ? {} : { afterTimeStep: Number(record.mfaLastTimeStep) }),
    });

    if (!result.valid) {
      return { valid: false };
    }

    // Recorded conditionally so two requests racing with the same code cannot
    // both advance the window — the second matches nothing and is rejected on
    // its next attempt.
    const advanced = await this.prisma.user.updateMany({
      where: {
        id: userId,
        OR: [{ mfaLastTimeStep: null }, { mfaLastTimeStep: { lt: BigInt(result.timeStep) } }],
      },
      data: { mfaLastTimeStep: BigInt(result.timeStep) },
    });

    if (advanced.count !== 1) {
      // Another request already consumed this step.
      return { valid: false };
    }

    return { valid: true, method: 'totp' };
  }

  /**
   * Turns MFA off and destroys the secret and every recovery code.
   *
   * Requires a currently valid second factor, so losing a session does not
   * let someone strip the protection off an account.
   */
  async disable(userId: string, submitted: string): Promise<boolean> {
    const result = await this.verifySecondFactor(userId, submitted);
    if (!result.valid) {
      return false;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaLastTimeStep: null },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    });

    this.logger.warn(`mfa disabled for user ${userId}`);
    return true;
  }

  /** Issues a fresh set of recovery codes, invalidating the previous ones. */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    return this.recoveryCodes.generate(userId);
  }

  /** Current MFA state for the status endpoint and the UI. */
  async status(userId: string): Promise<MfaStatus> {
    const [user, remaining] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { mfaEnabled: true, mfaSecretEncrypted: true },
      }),
      this.recoveryCodes.remaining(userId),
    ]);

    return {
      enabled: user?.mfaEnabled ?? false,
      enrolmentPending: user !== null && !user.mfaEnabled && user.mfaSecretEncrypted !== null,
      recoveryCodesRemaining: remaining,
      obligation: await this.obligationFor(userId),
    };
  }

  /**
   * Whether this user is obliged to have MFA (PLAN.md §8.3).
   *
   * Evaluated from their org memberships, so it changes when a role changes.
   */
  async obligationFor(userId: string): Promise<MfaObligation> {
    // Every org the user belongs to, on purpose: the obligation is the union
    // across orgs (see mfaObligationFor), so this read is cross-org by nature.
    const user = await this.prisma.unscoped('mfa obligation spans all of a user’s orgs', () =>
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          isPlatformAdmin: true,
          memberships: { select: { orgRole: true, org: { select: { settings: true } } } },
        },
      }),
    );

    if (user === null) {
      return { required: false, reason: null };
    }

    return mfaObligationFor({
      isPlatformAdmin: user.isPlatformAdmin,
      memberships: user.memberships.map((m) => ({
        orgRole: m.orgRole,
        settings: m.org.settings,
      })),
    });
  }

  private async loadSecret(userId: string): Promise<string | null> {
    const record = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecretEncrypted: true },
    });

    if (record === null || record.mfaSecretEncrypted === null) {
      return null;
    }

    return this.decryptSecret(userId, record.mfaSecretEncrypted);
  }

  /**
   * Decrypts a stored secret, treating failure as "no secret".
   *
   * A ciphertext we cannot read — wrong key, tampered row — must behave like a
   * missing factor and never as a 500 that tells a caller the account is
   * unusual. It is logged, because it means an operations problem.
   */
  private decryptSecret(userId: string, envelope: string): string | null {
    try {
      return this.crypto.decrypt(envelope, EncryptionContext.userMfaSecret(userId));
    } catch (error: unknown) {
      this.logger.error(
        `could not decrypt the mfa secret for user ${userId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return null;
    }
  }
}

export interface MfaEnrolment {
  /** Base32 secret, for manual entry. Shown once, during enrolment only. */
  secret: string;
  /** `otpauth://` URI the UI renders as a QR code. */
  provisioningUri: string;
}

export interface CompletedEnrolment {
  recoveryCodes: string[];
}

export type SecondFactorResult =
  | { valid: false }
  | { valid: true; method: 'totp' }
  | { valid: true; method: 'recovery_code'; recoveryCodesRemaining: number };

export interface MfaStatus {
  enabled: boolean;
  /** A secret has been generated but never proved. */
  enrolmentPending: boolean;
  recoveryCodesRemaining: number;
  obligation: MfaObligation;
}
