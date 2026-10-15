import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import { BreachedPasswordsService } from './breached-passwords';

/**
 * Password hashing and policy (PLAN.md §8.3).
 *
 * Hashing is **argon2id** as the plan specifies, with the parameters OWASP
 * currently recommends for a server-side login path: 19 MiB of memory, two
 * iterations, no parallelism. Memory cost is what defeats GPU cracking, so it
 * carries the weight rather than iteration count.
 *
 * The parameters are recorded in the hash string itself, so raising them later
 * does not invalidate existing hashes: `needsRehash` reports when a stored
 * hash predates the current parameters and the login path upgrades it in
 * place.
 */
@Injectable()
export class PasswordService {
  /** PLAN.md §8.3: minimum 12 characters. */
  static readonly MIN_LENGTH = 12;

  /**
   * Beyond this, the cost of hashing is attacker-controlled: argon2 reads the
   * whole input, so an unbounded password is a cheap way to tie up a worker.
   * 1 024 is far past any real passphrase.
   */
  static readonly MAX_LENGTH = 1_024;

  private static readonly OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  constructor(private readonly breached: BreachedPasswordsService) {}

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, PasswordService.OPTIONS);
  }

  /**
   * Verifies a password against a stored hash.
   *
   * Returns false rather than throwing on a malformed hash: a corrupted or
   * truncated `password_hash` column must read as "wrong password", never as a
   * 500 that tells an attacker the account is special.
   */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      return false;
    }
  }

  /** Whether a stored hash was produced with weaker parameters than current. */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, PasswordService.OPTIONS);
    } catch {
      // Unparseable: treat as needing replacement, which the caller can only
      // act on after a successful verify anyway.
      return true;
    }
  }

  /**
   * Applies the §8.3 policy.
   *
   * Returns every reason the password is unacceptable, not just the first, so
   * the UI can show one complete list instead of making a user guess again.
   */
  validate(plaintext: string, context: PasswordContext = {}): string[] {
    const problems: string[] = [];

    if (plaintext.length < PasswordService.MIN_LENGTH) {
      problems.push(`must be at least ${PasswordService.MIN_LENGTH.toString()} characters`);
    }

    if (plaintext.length > PasswordService.MAX_LENGTH) {
      problems.push(`must be at most ${PasswordService.MAX_LENGTH.toString()} characters`);
    }

    if (plaintext.trim() === '') {
      problems.push('must not be only whitespace');
    }

    if (this.breached.isBreached(plaintext)) {
      problems.push('appears in a list of commonly breached passwords');
    }

    // A password that is the user's own email (or its local part) survives
    // every length and dictionary rule and is the first thing anyone tries.
    const email = context.email?.toLowerCase().trim();
    if (email !== undefined && email !== '') {
      const candidate = plaintext.toLowerCase();
      const localPart = email.split('@')[0] ?? '';
      if (candidate === email || (localPart.length >= 4 && candidate === localPart)) {
        problems.push('must not be your email address');
      }
    }

    return problems;
  }
}

export interface PasswordContext {
  /** Checked so a password cannot simply be the account's own email. */
  email?: string;
}
