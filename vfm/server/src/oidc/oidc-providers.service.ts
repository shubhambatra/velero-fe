import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { OidcProvider } from '@prisma/client';

import { newId } from '../common/uuid';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { CryptoService, EncryptionContext } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { mappingsSchema, type OidcMapping } from './oidc.dto';

export interface ProviderView {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  groupClaim: string | null;
  mappings: OidcMapping[];
  jitEnabled: boolean;
  enabled: boolean;
}

/**
 * CRUD for an org's OIDC providers (PLAN.md §8.3, §9).
 *
 * The client secret goes in encrypted and never comes back out: no read path
 * here returns it, and a view cannot carry it because the type has no field
 * for it.
 */
@Injectable()
export class OidcProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(orgId: string): Promise<ProviderView[]> {
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.oidcProvider.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    return rows.map(view);
  }

  async create(
    orgId: string,
    input: {
      name: string;
      issuer: string;
      clientId: string;
      clientSecret: string;
      groupClaim?: string | null | undefined;
      mappings?: OidcMapping[] | undefined;
      jitEnabled?: boolean | undefined;
      enabled?: boolean | undefined;
    },
  ): Promise<ProviderView> {
    this.assertIssuer(input.issuer);
    const mappings = input.mappings ?? [];
    await this.assertTeams(orgId, mappings);

    const id = newId();
    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.oidcProvider.create({
        data: {
          id,
          orgId,
          name: input.name,
          issuer: input.issuer,
          clientId: input.clientId,
          clientSecretEncrypted: this.crypto.encrypt(
            input.clientSecret,
            EncryptionContext.oidcClientSecret(id),
          ),
          groupClaim: input.groupClaim ?? null,
          mappings,
          jitEnabled: input.jitEnabled ?? false,
          enabled: input.enabled ?? true,
        },
      }),
    );
    return view(row);
  }

  async update(
    orgId: string,
    id: string,
    input: {
      name?: string | undefined;
      issuer?: string | undefined;
      clientId?: string | undefined;
      clientSecret?: string | undefined;
      groupClaim?: string | null | undefined;
      mappings?: OidcMapping[] | undefined;
      jitEnabled?: boolean | undefined;
      enabled?: boolean | undefined;
    },
  ): Promise<ProviderView> {
    if (input.issuer !== undefined) {
      this.assertIssuer(input.issuer);
    }
    if (input.mappings !== undefined) {
      await this.assertTeams(orgId, input.mappings);
    }

    const existing = await this.prisma.inOrg(orgId, () =>
      this.prisma.oidcProvider.findUnique({ where: { id } }),
    );
    if (existing === null) {
      throw new NotFoundException('provider not found');
    }

    // Changing the issuer or client invalidates every stored subject: a `sub`
    // is only unique within one issuer. Refuse rather than let identities
    // from the old issuer be matched against the new one.
    if (
      (input.issuer !== undefined && input.issuer !== existing.issuer) ||
      (input.clientId !== undefined && input.clientId !== existing.clientId)
    ) {
      const linked = await this.prisma.inOrg(orgId, () =>
        this.prisma.oidcIdentity.count({ where: { providerId: id } }),
      );
      if (linked > 0 && input.issuer !== undefined && input.issuer !== existing.issuer) {
        throw new BadRequestException(
          'the issuer cannot change while users are linked to this provider; create a new provider instead',
        );
      }
    }

    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.oidcProvider.update({
        where: { id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
          ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
          ...(input.clientSecret === undefined
            ? {}
            : {
                clientSecretEncrypted: this.crypto.encrypt(
                  input.clientSecret,
                  EncryptionContext.oidcClientSecret(id),
                ),
              }),
          ...(input.groupClaim === undefined ? {} : { groupClaim: input.groupClaim }),
          ...(input.mappings === undefined ? {} : { mappings: input.mappings }),
          ...(input.jitEnabled === undefined ? {} : { jitEnabled: input.jitEnabled }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        },
      }),
    );
    return view(row);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const { count } = await this.prisma.inOrg(orgId, () =>
      this.prisma.oidcProvider.deleteMany({ where: { id } }),
    );
    if (count === 0) {
      throw new NotFoundException('provider not found');
    }
  }

  /** Providers shown on an org's sign-in page. Public, so id and name only. */
  async publicForOrgSlug(slug: string): Promise<{ id: string; name: string }[]> {
    const org = await this.prisma.organization.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (org === null) {
      return [];
    }
    const rows = await this.prisma.inOrg(org.id, () =>
      this.prisma.oidcProvider.findMany({
        where: { enabled: true },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows;
  }

  private assertIssuer(issuer: string): void {
    const url = new URL(issuer);
    // Production refuses plain http: the discovery document and the token
    // exchange carry the client secret and the authorization code. Dev allows
    // it so Dex can run on localhost without certificates.
    if (url.protocol !== 'https:' && this.env.NODE_ENV === 'production') {
      throw new BadRequestException('the issuer must use https');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new BadRequestException('the issuer must be an http(s) URL');
    }
  }

  /** Every mapped team must belong to this org. */
  private async assertTeams(orgId: string, mappings: OidcMapping[]): Promise<void> {
    mappingsSchema.parse(mappings);
    const ids = [...new Set(mappings.map((m) => m.teamId))];
    if (ids.length === 0) {
      return;
    }
    const found = await this.prisma.inOrg(orgId, () =>
      this.prisma.team.count({ where: { id: { in: ids } } }),
    );
    if (found !== ids.length) {
      throw new BadRequestException('a mapped team does not exist in this organization');
    }
  }
}

function view(row: OidcProvider): ProviderView {
  const parsed = mappingsSchema.safeParse(row.mappings);
  return {
    id: row.id,
    name: row.name,
    issuer: row.issuer,
    clientId: row.clientId,
    groupClaim: row.groupClaim,
    mappings: parsed.success ? parsed.data : [],
    jitEnabled: row.jitEnabled,
    enabled: row.enabled,
  };
}
