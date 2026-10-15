import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { createKeyring, decrypt, encrypt, keyIdOf, needsRewrap, type Keyring } from './envelope';

/**
 * The only way to read or write an `*_encrypted` column (PLAN.md §9).
 *
 * PLAN.md §9 allows for a KMS plugin interface and says v1 ships the env
 * implementation only, so the keyring is built from `VFM_MASTER_KEY` here and
 * nothing else in the codebase touches key material. Swapping in a KMS later
 * means replacing this provider, not auditing every call site.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly keyring: Keyring;

  constructor(@Inject(ENV) env: Env) {
    // `VFM_MASTER_KEY` is required by the env schema, which has already run by
    // the time this is constructed — startup fails there rather than here.
    // Encrypted columns exist from M1 day 5 onward, so booting without a key
    // would mean either storing secrets in the clear or failing at the first
    // write, and both are worse than refusing to start.
    this.keyring = createKeyring(env.VFM_MASTER_KEY, env.VFM_MASTER_KEY_PREVIOUS);

    const extra = this.keyring.all.size - 1;
    this.logger.log(
      extra === 0
        ? `envelope encryption ready (key ${this.keyring.primary.id})`
        : `envelope encryption ready (key ${this.keyring.primary.id}, ${extra.toString()} previous key(s) accepted for decryption)`,
    );
  }

  /**
   * Encrypts a value for storage.
   *
   * `context` identifies where the ciphertext will live — it is authenticated,
   * so the value cannot later be moved to another row or column.
   */
  encrypt(plaintext: string, context: string): string {
    return encrypt(this.keyring, plaintext, context);
  }

  /** Decrypts a stored value. Throws if `context` does not match. */
  decrypt(envelope: string, context: string): string {
    return decrypt(this.keyring, envelope, context);
  }

  /** Whether this ciphertext is still on a retired key and should be re-wrapped. */
  needsRewrap(envelope: string): boolean {
    return needsRewrap(this.keyring, envelope);
  }

  /** The key id currently used for new ciphertexts. */
  get primaryKeyId(): string {
    return this.keyring.primary.id;
  }

  /** The key id a stored ciphertext was produced with, for diagnostics. */
  keyIdOf(envelope: string): string | null {
    return keyIdOf(envelope);
  }
}

/**
 * Encryption contexts, in one place so a typo cannot silently create a second
 * namespace that fails to decrypt later.
 */
export const EncryptionContext = {
  /** A user's TOTP shared secret (PLAN.md §9 `users.mfa_secret_encrypted`). */
  userMfaSecret: (userId: string): string => `user.mfa_secret:${userId}`,
  /** An OIDC provider's client secret (M1 day 7). */
  oidcClientSecret: (providerId: string): string => `oidc_provider.client_secret:${providerId}`,
  /** A notification channel's configuration (M6). */
  notificationChannelConfig: (channelId: string): string =>
    `notification_channel.config:${channelId}`,
} as const;
