import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CryptoService, EncryptionContext } from './crypto.service';

export interface RewrapReport {
  /** Per column: how many values were read, how many were on an older key, how many were re-written. */
  columns: Record<string, { seen: number; stale: number; rewritten: number }>;
  /** Values that could not be decrypted at all (wrong key, damaged, wrong context). Nothing was written for them. */
  failures: string[];
  primaryKeyId: string;
}

/**
 * Moves every stored secret onto the primary key so a retired `VFM_MASTER_KEY` can be dropped
 * (THREAT_MODEL G-9). Each value is decrypted and encrypted again under its own context, then written with
 * a conditional update that only applies if the ciphertext is still the one that was read, so running it
 * while the server is up cannot overwrite a secret someone has just changed. It is safe to run twice.
 */
@Injectable()
export class RewrapService {
  private readonly logger = new Logger(RewrapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async run(options: { dryRun?: boolean } = {}): Promise<RewrapReport> {
    const dryRun = options.dryRun === true;
    const report: RewrapReport = {
      columns: {},
      failures: [],
      primaryKeyId: this.crypto.primaryKeyId,
    };

    const handle = async (
      column: string,
      id: string,
      value: string,
      context: string,
      write: (next: string) => Promise<number>,
    ): Promise<void> => {
      const c = (report.columns[column] ??= { seen: 0, stale: 0, rewritten: 0 });
      c.seen += 1;
      if (!this.crypto.needsRewrap(value)) return;
      c.stale += 1;
      try {
        const next = this.crypto.rewrap(value, context);
        if (!dryRun && (await write(next)) === 1) c.rewritten += 1;
      } catch {
        report.failures.push(`${column} ${id}`);
      }
    };

    await this.prisma.unscoped('re-wrapping stored secrets spans every org', async () => {
      for (const u of await this.prisma.user.findMany({
        where: { mfaSecretEncrypted: { not: null } },
        select: { id: true, mfaSecretEncrypted: true },
      })) {
        const value = u.mfaSecretEncrypted;
        if (value === null) continue;
        await handle(
          'users.mfa_secret_encrypted',
          u.id,
          value,
          EncryptionContext.userMfaSecret(u.id),
          async (next) =>
            (
              await this.prisma.user.updateMany({
                where: { id: u.id, mfaSecretEncrypted: value },
                data: { mfaSecretEncrypted: next },
              })
            ).count,
        );
      }
      for (const row of await this.prisma.certificateAuthority.findMany({
        select: { id: true, keyEncrypted: true },
      })) {
        await handle(
          'certificate_authority.key_encrypted',
          String(row.id),
          row.keyEncrypted,
          EncryptionContext.caPrivateKey(),
          async (next) =>
            (
              await this.prisma.certificateAuthority.updateMany({
                where: { id: row.id, keyEncrypted: row.keyEncrypted },
                data: { keyEncrypted: next },
              })
            ).count,
        );
      }
    });

    // The org-owned tables are read org by org, so the scoping extension still applies to them.
    const orgs = await this.prisma.unscoped('re-wrapping stored secrets spans every org', () =>
      this.prisma.organization.findMany({ select: { id: true } }),
    );
    for (const { id: orgId } of orgs) {
      await this.prisma.inOrg(orgId, async () => {
        for (const p of await this.prisma.oidcProvider.findMany({
          select: { id: true, clientSecretEncrypted: true },
        })) {
          await handle(
            'oidc_providers.client_secret_encrypted',
            p.id,
            p.clientSecretEncrypted,
            EncryptionContext.oidcClientSecret(p.id),
            async (next) =>
              (
                await this.prisma.oidcProvider.updateMany({
                  where: { id: p.id, clientSecretEncrypted: p.clientSecretEncrypted },
                  data: { clientSecretEncrypted: next },
                })
              ).count,
          );
        }
        for (const ch of await this.prisma.notificationChannel.findMany({
          select: { id: true, configEncrypted: true },
        })) {
          await handle(
            'notification_channels.config_encrypted',
            ch.id,
            ch.configEncrypted,
            EncryptionContext.notificationChannelConfig(ch.id),
            async (next) =>
              (
                await this.prisma.notificationChannel.updateMany({
                  where: { id: ch.id, configEncrypted: ch.configEncrypted },
                  data: { configEncrypted: next },
                })
              ).count,
          );
        }
      });
    }

    this.logger.log(
      `re-wrap ${dryRun ? '(dry run) ' : ''}onto key ${report.primaryKeyId}: ${JSON.stringify(report.columns)}; ${report.failures.length.toString()} failure(s)`,
    );
    return report;
  }
}
