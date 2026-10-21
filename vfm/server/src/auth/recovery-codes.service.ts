import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { newId } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Single-use recovery codes — PLAN.md §8.3: "recovery codes (10, hashed)".
 *
 * ## Why SHA-256 and not argon2id
 *
 * Passwords get argon2id because they are low-entropy and chosen by humans, so
 * an offline attacker guesses them. These codes are 80 bits of CSPRNG output.
 * There is nothing to guess: brute-forcing one is infeasible regardless of how
 * fast the hash is, so a slow KDF buys no security here and costs real time —
 * verification has to compare against up to ten stored hashes, which with
 * argon2id would mean half a second of CPU per attempt and a denial-of-service
 * lever. This is the same reasoning the API tokens of §8.3 will use.
 *
 * The hash still matters: a database leak must not yield usable codes.
 *
 * ## Single use
 *
 * Each code lives in its own row and is spent with
 * `UPDATE … WHERE id = … AND used_at IS NULL`, so two concurrent requests
 * presenting the same code cannot both succeed — the second updates zero rows.
 * Storing the codes in a JSON column would have made that a read-modify-write
 * race.
 *
 * Codes are never re-shown. {@link generate} replaces the whole set and returns
 * the plaintext exactly once.
 */
@Injectable()
export class RecoveryCodesService {
  /** PLAN.md §8.3: ten of them. */
  static readonly COUNT = 10;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Replaces a user's recovery codes and returns the new ones in plaintext.
   *
   * The caller must show them once and never store them. Replacing rather than
   * appending means a user who regenerates knows the previous set is dead.
   */
  async generate(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RecoveryCodesService.COUNT }, () => formatCode());

    await this.prisma.$transaction(async (tx) => {
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.mfaRecoveryCode.createMany({
        data: codes.map((code) => ({
          id: newId(),
          userId,
          codeHash: hashCode(code),
        })),
      });
    });

    return codes;
  }

  /**
   * Spends a recovery code.
   *
   * Returns false for an unknown code, a code belonging to another user, and
   * an already-used code alike — the caller cannot act differently on any of
   * them, and distinguishing them would leak which codes exist.
   */
  async consume(userId: string, submitted: string): Promise<boolean> {
    const candidateHash = hashCode(submitted);

    // Fetched by hash rather than compared in application code: the hash is of
    // high-entropy input, so an indexed equality lookup is safe here and does
    // not require walking every row.
    const match = await this.prisma.mfaRecoveryCode.findFirst({
      where: { userId, codeHash: candidateHash, usedAt: null },
      select: { id: true, codeHash: true },
    });

    if (match === null) {
      return false;
    }

    // Belt and braces: confirm the stored hash really equals the candidate,
    // in constant time, so the outcome never depends on a partial comparison
    // somewhere in the query layer.
    if (!hashesEqual(match.codeHash, candidateHash)) {
      return false;
    }

    // The WHERE clause is what enforces single use: a concurrent request that
    // already spent this code leaves `usedAt` set, and this update matches
    // nothing.
    const spent = await this.prisma.mfaRecoveryCode.updateMany({
      where: { id: match.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    return spent.count === 1;
  }

  /** How many codes a user has left, for the MFA status endpoint. */
  async remaining(userId: string): Promise<number> {
    return this.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  /** Drops every code, used when MFA is disabled. */
  async clear(userId: string): Promise<void> {
    await this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } });
  }
}

/**
 * Normalises a submitted code before hashing.
 *
 * Users retype these from paper, so case and the grouping dashes must not
 * matter. Exported for the tests that assert exactly that.
 */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export function hashCode(code: string): string {
  return createHash('sha256').update(normalizeCode(code), 'utf8').digest('hex');
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 10 bytes of entropy → exactly 16 base32 characters, with nothing wasted. */
const CODE_BYTES = 10;

/** RFC 4648 base32, which already omits the characters people confuse. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * A single code: 80 bits rendered as base32 and grouped in fours, so it can be
 * read off paper and typed without losing one's place.
 *
 * Five bits are consumed at a time from the byte buffer. Mapping bytes to
 * characters any more loosely than this either wastes entropy or biases the
 * output.
 */
function formatCode(): string {
  const bytes = randomBytes(CODE_BYTES);

  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((value >>> bits) & 0b11111);
    }
  }

  // 80 bits divides exactly by 5, so no partial group is ever left over.
  return (out.match(/.{1,4}/g) ?? []).join('-');
}
