import { Injectable } from '@nestjs/common';

import { newId } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';

/**
 * Reads and writes the `users` table (PLAN.md §9).
 *
 * Email handling: §9 gives `email` a plain unique index, so this service is
 * the only place that normalises it. Every read and write goes through
 * {@link normalizeEmail}, which is what makes the index effectively
 * case-insensitive without requiring the `citext` extension — see the comment
 * on the model in `schema.prisma`.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves a session's user id to the projection the request carries.
   *
   * Returns null for a disabled account, so `SessionGuard` treats disabling as
   * immediate revocation rather than something that takes effect at the next
   * login.
   */
  async findAuthenticatedById(id: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        isPlatformAdmin: true,
        mfaEnabled: true,
        disabledAt: true,
      },
    });

    if (user === null || user.disabledAt !== null) {
      return null;
    }

    const { disabledAt: _disabledAt, ...authenticated } = user;
    return authenticated;
  }

  /**
   * Looks up an account for the login path, including the password hash.
   *
   * Separate from {@link findAuthenticatedById} so the hash is only loaded
   * where it is needed: it must not end up on `request.user`, in a log line,
   * or in an audit event.
   */
  async findForLogin(email: string): Promise<LoginCandidate | null> {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        isPlatformAdmin: true,
        mfaEnabled: true,
        disabledAt: true,
      },
    });
  }

  /** Whether any user exists at all, which gates the one-time setup flow. */
  async isEmpty(): Promise<boolean> {
    const first = await this.prisma.user.findFirst({ select: { id: true } });
    return first === null;
  }

  /**
   * Creates the first platform administrator.
   *
   * Guarded by a transaction that re-checks emptiness, so two requests racing
   * with the same setup token cannot both create an admin. PLAN.md §16 day 4:
   * "No open self-signup" — this is the only user-creation path in M1 day 4,
   * and it closes permanently once a user exists.
   */
  async createFirstPlatformAdmin(input: {
    email: string;
    name: string | null;
    passwordHash: string;
  }): Promise<AuthenticatedUser> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findFirst({ select: { id: true } });
      if (existing !== null) {
        throw new PlatformAlreadyInitialisedError();
      }

      const user = await tx.user.create({
        data: {
          id: newId(),
          email: normalizeEmail(input.email),
          name: input.name,
          passwordHash: input.passwordHash,
          isPlatformAdmin: true,
        },
        select: {
          id: true,
          email: true,
          name: true,
          isPlatformAdmin: true,
          mfaEnabled: true,
        },
      });

      return user;
    });
  }

  /** Replaces a stored hash, used when login upgrades argon2 parameters. */
  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  async recordLogin(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }
}

export interface LoginCandidate {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  isPlatformAdmin: boolean;
  mfaEnabled: boolean;
  disabledAt: Date | null;
}

/** Thrown when the one-time setup flow is attempted after initialisation. */
export class PlatformAlreadyInitialisedError extends Error {
  constructor() {
    super('the platform already has a user');
    this.name = 'PlatformAlreadyInitialisedError';
  }
}

/**
 * Canonical form of an email address for storage and lookup.
 *
 * Lower-cased and trimmed, and nothing more: stripping dots or `+tags` is a
 * Gmail-specific convention, and applying it generally would merge accounts
 * that the identity provider considers distinct.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
