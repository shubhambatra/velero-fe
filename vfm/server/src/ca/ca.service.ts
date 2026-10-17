import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { CaState } from '@prisma/client';

import { CryptoService, EncryptionContext } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CertificateError,
  generateCa,
  issueServerCertificate,
  loadCa,
  loadCaCertificate,
  NOT_ISSUED,
  signAgentCsr,
  verifyClientCertificate,
  type CaMaterial,
  type IssuedCertificate,
  type VerifiedClientCertificate,
} from './ca';

const CA_ROW_ID = 1;

/** How often a replica checks whether an operator has staged, promoted or retired a CA. Tests set it to 0. */
export const caOptions = { refreshMs: 30_000 };

/** What one replica holds in memory, rebuilt whenever the table's states change. */
interface CaSet {
  /** The ACTIVE CA: the only one that signs. */
  signer: CaMaterial;
  /** Every CA whose certificates are still accepted (ACTIVE and RETIRING). */
  verifiers: Pick<CaMaterial, 'certificate'>[];
  /** The CAs whose client certificates the gateway's TLS layer accepts (not the staged one). */
  clientTrustPem: string;
  /** What agents are told to trust: ACTIVE first, then STAGED, then RETIRING. */
  bundlePem: string;
  /** Changes exactly when the set of rows or any row's state does. */
  version: string;
}

const ORDER: Record<CaState, number> = { ACTIVE: 0, STAGED: 1, RETIRING: 2 };

/**
 * The control plane's internal CA (PLAN.md §5.1): "generated on first start,
 * encrypted with `VFM_MASTER_KEY`".
 *
 * Replicas race at first start. Each generates a candidate and inserts it with
 * `ON CONFLICT DO NOTHING` on a fixed primary key, so exactly one wins, and every
 * replica then loads the stored row, so all of them sign with the same CA.
 *
 * A CA can be replaced without re-enrolling anyone (docs/DECISIONS.md ADR-043): a second CA is
 * STAGED and added to the bundle every agent receives with its next certificate, then promoted
 * to sign, and the old one is retired once everything it signed has expired. See `CaRotationService`.
 */
@Injectable()
export class CaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaService.name);
  private set: Promise<CaSet> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ready();
    if (caOptions.refreshMs > 0) {
      this.timer = setInterval(() => {
        this.reload().catch((error: unknown) => {
          this.logger.warn(
            `could not check for a CA change: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        });
      }, caOptions.refreshMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
  }

  ready(): Promise<CaSet> {
    this.set ??= this.load();
    // A failed first load must not be remembered forever.
    this.set.catch(() => {
      this.set = undefined;
    });
    return this.set;
  }

  /** Called when the signing CA or the bundle changes, so the gateway can reissue what depends on them. */
  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** Re-reads the table; true if anything changed. */
  async reload(): Promise<boolean> {
    const before = await this.ready();
    const next = await this.load();
    if (next.version === before.version) return false;
    this.set = Promise.resolve(next);
    this.logger.log('the certificate authority set changed; now using the new one');
    for (const listener of this.listeners) listener();
    return true;
  }

  /** What the gateway's TLS layer trusts to have issued a client certificate. */
  async clientTrustPem(): Promise<string> {
    return (await this.ready()).clientTrustPem;
  }

  /** PEM bundle handed to agents so they can pin it: one certificate unless a rotation is under way. */
  async certificatePem(): Promise<string> {
    return (await this.ready()).bundlePem;
  }

  async signAgentCsr(csrPem: string, clusterId: string): Promise<IssuedCertificate> {
    return signAgentCsr((await this.ready()).signer, csrPem, clusterId);
  }

  async verifyClientCertificate(der: Buffer): Promise<VerifiedClientCertificate> {
    const { verifiers } = await this.ready();
    for (const ca of verifiers) {
      try {
        return verifyClientCertificate(ca, der);
      } catch (error) {
        if (!(error instanceof CertificateError) || error.message !== NOT_ISSUED) throw error;
      }
    }
    throw new CertificateError(NOT_ISSUED);
  }

  async issueServerCertificate(hostnames: readonly string[]) {
    return issueServerCertificate((await this.ready()).signer, hostnames);
  }

  private async load(): Promise<CaSet> {
    let rows = await this.prisma.certificateAuthority.findMany();

    if (rows.length === 0) {
      const generated = await generateCa();
      const created = await this.prisma.certificateAuthority.createMany({
        data: [
          {
            id: CA_ROW_ID,
            certificatePem: generated.certificatePem,
            keyEncrypted: this.crypto.encrypt(
              generated.privateKeyPkcs8.toString('base64'),
              EncryptionContext.caPrivateKey(),
            ),
            notAfter: generated.notAfter,
          },
        ],
        skipDuplicates: true,
      });
      this.logger.log(
        created.count === 1
          ? 'generated the internal certificate authority'
          : 'another replica created the internal certificate authority first; using it',
      );
      rows = await this.prisma.certificateAuthority.findMany();
    }

    rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.id - b.id);
    const active = rows.find((r) => r.state === 'ACTIVE');
    if (active === undefined) {
      throw new Error('no ACTIVE certificate authority: finish or undo the rotation in progress');
    }

    const key = this.crypto.decrypt(active.keyEncrypted, EncryptionContext.caPrivateKey());
    const signer = await loadCa(active.certificatePem, Buffer.from(key, 'base64'));
    const trusted = rows.filter((r) => r.state !== 'STAGED');
    const verifiers = trusted.map((r) => loadCaCertificate(r.certificatePem));
    const pem = (list: typeof rows): string =>
      list
        .map((r) => (r.certificatePem.endsWith('\n') ? r.certificatePem : `${r.certificatePem}\n`))
        .join('');
    return {
      signer,
      verifiers,
      clientTrustPem: pem(trusted),
      bundlePem: pem(rows),
      version: rows.map((r) => `${r.id.toString()}:${r.state}`).join(','),
    };
  }
}
