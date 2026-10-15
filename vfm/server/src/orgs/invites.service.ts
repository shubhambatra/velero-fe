import { createHash, randomBytes } from 'node:crypto';

import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type OrgRole } from '@prisma/client';

import { PasswordService } from '../auth/password.service';
import { newId } from '../common/uuid';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeEmail } from '../users/users.service';

/** Seven days: long enough to survive a weekend, short enough to expire unused. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface InviteView {
  id: string;
  email: string;
  orgRole: OrgRole;
  expiresAt: string;
  createdAt: string;
}

/** Why an invite could not be used. One public message for all of them. */
export class InviteRejectedError extends Error {
  constructor(readonly reason: 'unknown' | 'expired' | 'used' | 'wrong_address' | 'has_account') {
    super('invalid or expired invitation');
    this.name = 'InviteRejectedError';
  }
}

/**
 * Email invitations (PLAN.md §16 day 6).
 *
 * The properties that matter, each pinned by a test:
 *  - **single use** — acceptance is one conditional UPDATE, so a replay
 *    matches no row;
 *  - **bound to an address** — only the account holding the invited address
 *    can accept, so a forwarded link is worthless;
 *  - **hashed at rest** — the database holds SHA-256 of the token, so a read
 *    of the table yields no usable invitation (ADR-009 on why a fast hash is
 *    right for a 256-bit random token).
 */
@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly passwords: PasswordService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(
    orgId: string,
    invitedById: string,
    input: { email: string; orgRole: OrgRole },
  ): Promise<InviteView> {
    const email = normalizeEmail(input.email);

    // Fail before writing anything if mail cannot go out: an invite nobody
    // can receive is worse than an error the admin can act on.
    if (!this.mail.configured) {
      await this.mail.send({ to: email, subject: '', text: '' }); // throws 503
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    });
    if (org === null) {
      throw new NotFoundException('organization not found');
    }

    const token = randomBytes(32).toString('base64url');
    const id = newId();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await this.prisma.inOrg(orgId, async () => {
      const existingMember = await this.prisma.membership.findFirst({
        where: { user: { email } },
        select: { id: true },
      });
      if (existingMember !== null) {
        throw new ConflictException('that address already belongs to a member');
      }

      return this.prisma.$transaction(async (tx) => {
        // One live invitation per address: re-inviting replaces the old link,
        // which therefore stops working.
        await tx.invite.deleteMany({ where: { email, acceptedAt: null } });
        return tx.invite.create({
          data: {
            id,
            orgId,
            email,
            orgRole: input.orgRole,
            tokenHash: hashToken(token),
            invitedById,
            expiresAt,
          },
        });
      });
    });

    const link = `${this.env.PUBLIC_URL}/invite?token=${encodeURIComponent(token)}`;
    try {
      await this.mail.send({
        to: email,
        subject: `You have been invited to ${org.name}`,
        text:
          `You were invited to join "${org.name}" as ${input.orgRole.toLowerCase()}.\n\n` +
          `Accept the invitation: ${link}\n\n` +
          `This link works once, only for ${email}, and expires on ${expiresAt.toUTCString()}.\n`,
      });
    } catch (error: unknown) {
      // The row exists but nobody can use it; remove it so the admin can retry
      // cleanly instead of finding a phantom pending invite.
      await this.prisma.inOrg(orgId, () => this.prisma.invite.delete({ where: { id } }));
      throw error;
    }

    return view(invite);
  }

  async list(orgId: string): Promise<InviteView[]> {
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.invite.findMany({
        where: { acceptedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map(view);
  }

  async revoke(orgId: string, inviteId: string): Promise<void> {
    const { count } = await this.prisma.inOrg(orgId, () =>
      this.prisma.invite.deleteMany({ where: { id: inviteId, acceptedAt: null } }),
    );
    if (count === 0) {
      throw new NotFoundException('invitation not found');
    }
  }

  /** Accepts for an account that already exists and is signed in. */
  async accept(token: string, user: { id: string; email: string }): Promise<{ orgId: string }> {
    const invite = await this.lookup(token);
    if (normalizeEmail(user.email) !== invite.email) {
      throw new InviteRejectedError('wrong_address');
    }
    return this.consume(invite, user.id);
  }

  /**
   * Accepts for someone with no account yet, creating it.
   *
   * This is the only way a user comes into being after the first admin — the
   * plan has no open self-signup (§16 day 4) — so it is gated on holding a
   * valid token for the address.
   */
  async register(
    token: string,
    input: { password: string; name?: string | undefined },
  ): Promise<{
    orgId: string;
    user: {
      id: string;
      email: string;
      name: string | null;
      isPlatformAdmin: boolean;
      mfaEnabled: boolean;
    };
  }> {
    const invite = await this.lookup(token);

    const problems = this.passwords.validate(input.password, { email: invite.email });
    if (problems.length > 0) {
      throw new UnprocessableEntityException({ message: problems });
    }

    const hasAccount = await this.prisma.user.findUnique({
      where: { email: invite.email },
      select: { id: true },
    });
    if (hasAccount !== null) {
      // Must sign in and use /invites/accept; registering over an existing
      // address would be an account takeover primitive.
      throw new InviteRejectedError('has_account');
    }

    const passwordHash = await this.passwords.hash(input.password);
    const userId = newId();
    let user;
    try {
      user = await this.prisma.user.create({
        data: { id: userId, email: invite.email, name: input.name ?? null, passwordHash },
        select: { id: true, email: true, name: true, isPlatformAdmin: true, mfaEnabled: true },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new InviteRejectedError('has_account');
      }
      throw error;
    }

    try {
      const { orgId } = await this.consume(invite, user.id);
      return { orgId, user };
    } catch (error: unknown) {
      // Lost a race for the invite: do not leave an account behind.
      await this.prisma.user.delete({ where: { id: user.id } });
      throw error;
    }
  }

  private async lookup(token: string) {
    const invite = await this.prisma.unscoped('an invite token identifies its org', () =>
      this.prisma.invite.findUnique({ where: { tokenHash: hashToken(token) } }),
    );
    if (invite === null) {
      throw new InviteRejectedError('unknown');
    }
    if (invite.acceptedAt !== null) {
      throw new InviteRejectedError('used');
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new InviteRejectedError('expired');
    }
    return invite;
  }

  private async consume(
    invite: { id: string; orgId: string; orgRole: OrgRole },
    userId: string,
  ): Promise<{ orgId: string }> {
    await this.prisma.inOrg(invite.orgId, () =>
      this.prisma.$transaction(async (tx) => {
        // The single-use guarantee: only one caller can flip acceptedAt from
        // NULL, and an expired invite matches nothing.
        const claimed = await tx.invite.updateMany({
          where: { id: invite.id, acceptedAt: null, expiresAt: { gt: new Date() } },
          data: { acceptedAt: new Date() },
        });
        if (claimed.count !== 1) {
          throw new InviteRejectedError('used');
        }
        try {
          await tx.membership.create({
            data: { id: newId(), orgId: invite.orgId, userId, orgRole: invite.orgRole },
          });
        } catch (error: unknown) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new ConflictException('already a member of this organization');
          }
          throw error;
        }
      }),
    );
    this.logger.log(`invitation ${invite.id} accepted by ${userId}`);
    return { orgId: invite.orgId };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function view(row: {
  id: string;
  email: string;
  orgRole: OrgRole;
  expiresAt: Date;
  createdAt: Date;
}): InviteView {
  return {
    id: row.id,
    email: row.email,
    orgRole: row.orgRole,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
