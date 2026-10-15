import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import * as client from 'openid-client';

import { PRODUCT_SLUG } from '@vfm/shared';

import { newId } from '../common/uuid';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { CryptoService, EncryptionContext } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { normalizeEmail } from '../users/users.service';
import { mappingsSchema } from './oidc.dto';

const STATE_TTL_SECONDS = 10 * 60;

interface PendingLogin {
  providerId: string;
  nonce: string;
  verifier: string;
}

export class OidcLoginError extends Error {
  constructor(
    readonly reason:
      | 'unknown_state'
      | 'provider_unavailable'
      | 'idp_error'
      | 'token_exchange_failed'
      | 'email_unverified'
      | 'unknown_user'
      | 'not_a_member'
      | 'disabled',
  ) {
    super(`oidc sign-in refused: ${reason}`);
    this.name = 'OidcLoginError';
  }
}

export interface OidcLoginResult {
  user: {
    id: string;
    email: string;
    name: string | null;
    isPlatformAdmin: boolean;
    mfaEnabled: boolean;
  };
  orgId: string;
}

/**
 * The OpenID Connect authorization-code flow with PKCE (PLAN.md §8.3).
 *
 * Three independent bindings tie a callback to the login that started it,
 * and each is checked, because each stops a different attack:
 *  - **state** (single-use, in Redis) — the callback was asked for by us;
 *  - **the state cookie** — it was asked for by *this browser*, which stops
 *    login CSRF (an attacker feeding a victim their own authorization code);
 *  - **nonce and PKCE verifier** — the ID token and the code exchange belong
 *    to this request, which stops token and code replay.
 */
@Injectable()
export class OidcLoginService {
  private readonly logger = new Logger(OidcLoginService.name);

  static readonly STATE_COOKIE = `${PRODUCT_SLUG}_oidc_state`;
  static readonly STATE_COOKIE_MAX_AGE_MS = STATE_TTL_SECONDS * 1_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get redirectUri(): string {
    return `${this.env.API_PUBLIC_URL}/api/v1/auth/oidc/callback`;
  }

  /** Builds the IdP redirect and remembers what the callback must match. */
  async start(providerId: string): Promise<{ url: string; state: string }> {
    const provider = await this.loadProvider(providerId);
    const config = await this.discover(provider);

    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);

    const pending: PendingLogin = { providerId, nonce, verifier };
    await this.redis.connection.set(
      stateKey(state),
      JSON.stringify(pending),
      'EX',
      STATE_TTL_SECONDS,
    );

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: provider.groupClaim === null ? 'openid email profile' : 'openid email profile groups',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    return { url: url.href, state };
  }

  /** Completes a login. Throws {@link OidcLoginError} for every refusal. */
  async complete(input: {
    callbackUrl: URL;
    state: string;
    cookieState: string | undefined;
    idpError: string | undefined;
  }): Promise<OidcLoginResult> {
    // Single use: the key is consumed whatever happens next, so a failed or
    // replayed callback cannot be retried.
    const raw = await this.redis.connection.getdel(stateKey(input.state));
    if (raw === null || input.cookieState !== input.state) {
      throw new OidcLoginError('unknown_state');
    }
    const pending = JSON.parse(raw) as PendingLogin;

    if (input.idpError !== undefined) {
      throw new OidcLoginError('idp_error');
    }

    const provider = await this.loadProvider(pending.providerId);
    const config = await this.discover(provider);

    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(config, input.callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: input.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (error: unknown) {
      this.logger.warn(
        `token exchange failed for provider ${provider.id}: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      throw new OidcLoginError('token_exchange_failed');
    }
    if (claims === undefined) {
      throw new OidcLoginError('token_exchange_failed');
    }

    return this.prisma.inOrg(provider.orgId, async () => {
      const user = await this.resolveUser(provider, claims);
      await this.syncTeams(provider, user.id, claims);
      return { user, orgId: provider.orgId };
    });
  }

  private async resolveUser(
    provider: { id: string; orgId: string; jitEnabled: boolean },
    claims: client.IDToken,
  ): Promise<OidcLoginResult['user']> {
    const select = {
      id: true,
      email: true,
      name: true,
      isPlatformAdmin: true,
      mfaEnabled: true,
      disabledAt: true,
    } as const;

    // 1. A subject we have seen before. Never re-matched by email.
    const identity = await this.prisma.oidcIdentity.findUnique({
      where: { providerId_subject: { providerId: provider.id, subject: claims.sub } },
      select: { user: { select } },
    });
    if (identity !== null) {
      return enabled(identity.user);
    }

    // 2. First sight of this subject. The address is the only thing linking it
    // to an account, so it must be present and verified by the IdP.
    const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : '';
    if (email === '' || claims.email_verified !== true) {
      throw new OidcLoginError('email_unverified');
    }

    const existing = await this.prisma.user.findUnique({ where: { email }, select });
    if (existing !== null) {
      // Linking by address is allowed only into an org the account already
      // belongs to. Otherwise a provider could pull any existing account into
      // its org — or sign in as it — by asserting its address.
      const member = await this.prisma.membership.findUnique({
        where: { orgId_userId: { orgId: provider.orgId, userId: existing.id } },
        select: { id: true },
      });
      if (member === null) {
        throw new OidcLoginError('not_a_member');
      }
      const user = enabled(existing);
      await this.prisma.oidcIdentity.create({
        data: {
          id: newId(),
          orgId: provider.orgId,
          providerId: provider.id,
          userId: user.id,
          subject: claims.sub,
        },
      });
      return user;
    }

    // 3. No account at all: only JIT may create one.
    if (!provider.jitEnabled) {
      throw new OidcLoginError('unknown_user');
    }

    const userId = newId();
    const name =
      typeof claims.name === 'string' && claims.name !== '' ? claims.name.slice(0, 200) : null;
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.create({
        // passwordHash stays null: an OIDC-only account has no password and
        // login treats a missing hash as "cannot sign in with a password".
        data: { id: userId, email, name },
        select,
      });
      await tx.membership.create({
        data: { id: newId(), orgId: provider.orgId, userId, orgRole: 'MEMBER' },
      });
      await tx.oidcIdentity.create({
        data: {
          id: newId(),
          orgId: provider.orgId,
          providerId: provider.id,
          userId,
          subject: claims.sub,
        },
      });
      return row;
    });
    this.logger.log(`provisioned user ${userId} through provider ${provider.id}`);
    return enabled(created);
  }

  /**
   * Makes the user's membership of the *mapped* teams match their groups.
   *
   * Only teams named in this provider's mappings are touched, so teams managed
   * by hand are left alone. A mapped team is therefore IdP-managed: a manual
   * addition to it is removed at the next sign-in.
   */
  private async syncTeams(
    provider: { orgId: string; groupClaim: string | null; mappings: unknown },
    userId: string,
    claims: client.IDToken,
  ): Promise<void> {
    if (provider.groupClaim === null) {
      return;
    }
    const parsed = mappingsSchema.safeParse(provider.mappings);
    if (!parsed.success || parsed.data.length === 0) {
      return;
    }

    const raw = claims[provider.groupClaim];
    const groups = new Set(
      Array.isArray(raw)
        ? raw.filter((g): g is string => typeof g === 'string')
        : typeof raw === 'string'
          ? [raw]
          : [],
    );

    const managed = new Set(parsed.data.map((m) => m.teamId));
    const wanted = new Set(parsed.data.filter((m) => groups.has(m.group)).map((m) => m.teamId));

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.teamMember.findMany({
        where: { userId, teamId: { in: [...managed] } },
        select: { teamId: true },
      });
      const have = new Set(current.map((c) => c.teamId));

      const toAdd = [...wanted].filter((t) => !have.has(t));
      const toRemove = [...have].filter((t) => !wanted.has(t));

      if (toAdd.length > 0) {
        await tx.teamMember.createMany({
          data: toAdd.map((teamId) => ({ id: newId(), orgId: provider.orgId, teamId, userId })),
          skipDuplicates: true,
        });
      }
      if (toRemove.length > 0) {
        await tx.teamMember.deleteMany({ where: { userId, teamId: { in: toRemove } } });
      }
    });
  }

  private async loadProvider(id: string) {
    // The id in the URL is all an anonymous caller has, so the org is not
    // known yet: this lookup is what establishes it.
    const provider = await this.prisma.unscoped('an oidc provider id identifies its org', () =>
      this.prisma.oidcProvider.findUnique({ where: { id } }),
    );
    if (provider === null || !provider.enabled) {
      throw new OidcLoginError('provider_unavailable');
    }
    return provider;
  }

  private discover(provider: {
    id: string;
    issuer: string;
    clientId: string;
    clientSecretEncrypted: string;
  }): Promise<client.Configuration> {
    const secret = this.crypto.decrypt(
      provider.clientSecretEncrypted,
      EncryptionContext.oidcClientSecret(provider.id),
    );
    const url = new URL(provider.issuer);
    return client.discovery(
      url,
      provider.clientId,
      secret,
      undefined,
      // Plain http is accepted only outside production (and the admin API
      // refuses to store an http issuer in production in the first place).
      url.protocol === 'http:' && this.env.NODE_ENV !== 'production'
        ? // Deliberate: the library deprecates it to make it stand out. It is
          // reachable only for an http issuer outside production (dev Dex).
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          { execute: [client.allowInsecureRequests] }
        : {},
    );
  }
}

function enabled<T extends { disabledAt: Date | null }>(user: T): Omit<T, 'disabledAt'> {
  if (user.disabledAt !== null) {
    throw new OidcLoginError('disabled');
  }
  const { disabledAt: _disabledAt, ...rest } = user;
  return rest;
}

function stateKey(state: string): string {
  return `${PRODUCT_SLUG}:oidc:state:${state}`;
}
