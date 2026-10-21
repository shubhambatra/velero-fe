import { createHash, randomBytes } from 'node:crypto';

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isPermission } from '@vfm/shared';

import { newId } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';

/** What a request carries once a bearer token has authenticated it. */
export interface ApiTokenPrincipal {
  id: string;
  orgId: string;
  userId: string;
  permissions: string[] | null;
  clusterIds: string[] | null;
}

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  permissions: string[] | null;
  clusterIds: string[] | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  ownerId: string;
  ownerEmail?: string;
}

declare module 'express' {
  interface Request {
    /** Set when the request authenticated with an API token instead of a session. */
    apiToken?: ApiTokenPrincipal;
  }
}

const TOKEN_SHAPE = /^vfm_[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVE_PER_USER = 50;
/** `last_used_at` is for humans; writing it on every call would make reads write. */
const LAST_USED_GRANULARITY_MS = 60_000;

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;

/**
 * API tokens for automation (PLAN.md §8.3: prefix `vfm_`, shown once, stored
 * hashed, optional expiry, optional reduced permission set and cluster subset).
 *
 * 256 bits of CSPRNG output, so a fast hash is the right one (ADR-009): there
 * is no low-entropy secret to slow-hash, and the lookup runs on every request.
 */
@Injectable()
export class ApiTokensService {
  constructor(private readonly prisma: PrismaService) {}

  static looksLikeToken(value: string): boolean {
    return TOKEN_SHAPE.test(value);
  }

  async create(
    orgId: string,
    userId: string,
    input: {
      name: string;
      permissions?: string[] | undefined;
      clusterIds?: string[] | undefined;
      expiresInDays?: number | undefined;
    },
  ): Promise<ApiTokenView & { token: string }> {
    const unknown = (input.permissions ?? []).filter((p) => !isPermission(p));
    if (unknown.length > 0) {
      throw new ConflictException(`unknown permission: ${unknown[0] ?? ''}`);
    }

    const active = await this.prisma.inOrg(orgId, () =>
      this.prisma.apiToken.count({
        where: {
          userId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      }),
    );
    if (active >= MAX_ACTIVE_PER_USER) {
      throw new ConflictException('too many active tokens; revoke some first');
    }

    const secret = randomBytes(32).toString('base64url');
    const token = `vfm_${secret}`;
    const id = newId();
    const expiresAt =
      input.expiresInDays === undefined
        ? null
        : new Date(Date.now() + input.expiresInDays * 86_400_000);

    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.apiToken.create({
        data: {
          id,
          orgId,
          userId,
          name: input.name,
          prefix: token.slice(0, 12),
          tokenHash: sha256(token),
          ...(input.permissions === undefined
            ? {}
            : { permissions: [...new Set(input.permissions)] }),
          ...(input.clusterIds === undefined ? {} : { clusterIds: [...new Set(input.clusterIds)] }),
          expiresAt,
        },
      }),
    );

    return { ...view(row), token };
  }

  /** `scope: 'org'` lists everyone's tokens and needs an Owner/Admin. */
  async list(orgId: string, userId: string, scope: 'own' | 'org'): Promise<ApiTokenView[]> {
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.apiToken.findMany({
        where: scope === 'own' ? { userId } : {},
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { email: true } } },
      }),
    );
    return rows.map((r) => ({ ...view(r), ownerEmail: r.user.email }));
  }

  /** Idempotent. `ownerOnly` limits a member to their own tokens. */
  async revoke(orgId: string, tokenId: string, actorId: string, ownerOnly: boolean): Promise<void> {
    const found = await this.prisma.inOrg(orgId, () =>
      this.prisma.apiToken.findUnique({
        where: { id: tokenId },
        select: { userId: true, revokedAt: true },
      }),
    );
    // Someone else's token is "not found" to a member, so ids do not leak.
    if (found === null || (ownerOnly && found.userId !== actorId)) {
      throw new NotFoundException('token not found');
    }
    if (found.revokedAt !== null) {
      return;
    }
    await this.prisma.inOrg(orgId, () =>
      this.prisma.apiToken.updateMany({
        where: { id: tokenId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /**
   * Resolves a bearer token, or `null` for any reason it is unusable. One
   * answer for unknown, revoked, expired and orphaned so the endpoint is not a
   * token oracle.
   */
  async authenticate(token: string): Promise<ApiTokenPrincipal | null> {
    if (!TOKEN_SHAPE.test(token)) {
      return null;
    }
    const row = await this.prisma.unscoped('an api token identifies its org', () =>
      this.prisma.apiToken.findUnique({
        where: { tokenHash: sha256(token) },
        include: { user: { select: { disabledAt: true } } },
      }),
    );
    const now = Date.now();
    if (
      row === null ||
      row.revokedAt !== null ||
      (row.expiresAt !== null && row.expiresAt.getTime() <= now) ||
      row.user.disabledAt !== null
    ) {
      return null;
    }

    // Membership is the root of every grant: a user removed from the org must
    // not keep acting through a token minted while they were in it.
    const member = await this.prisma.inOrg(row.orgId, () =>
      this.prisma.membership.findUnique({
        where: { orgId_userId: { orgId: row.orgId, userId: row.userId } },
        select: { id: true },
      }),
    );
    if (member === null) {
      return null;
    }

    if (row.lastUsedAt === null || now - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS) {
      void this.prisma
        .inOrg(row.orgId, () =>
          this.prisma.apiToken.updateMany({
            where: { id: row.id },
            data: { lastUsedAt: new Date(now) },
          }),
        )
        .catch(() => undefined);
    }

    return {
      id: row.id,
      orgId: row.orgId,
      userId: row.userId,
      permissions: strings(row.permissions),
      clusterIds: strings(row.clusterIds),
    };
  }
}

function view(row: {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  permissions: unknown;
  clusterIds: unknown;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    permissions: strings(row.permissions),
    clusterIds: strings(row.clusterIds),
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    ownerId: row.userId,
  };
}
