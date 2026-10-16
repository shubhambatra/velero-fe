import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { CryptoService, EncryptionContext } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  generateCa,
  issueServerCertificate,
  loadCa,
  signAgentCsr,
  verifyClientCertificate,
  type CaMaterial,
  type IssuedCertificate,
  type VerifiedClientCertificate,
} from './ca';

const CA_ROW_ID = 1;

/**
 * The control plane's internal CA (PLAN.md §5.1): "generated on first start,
 * encrypted with `VFM_MASTER_KEY`".
 *
 * Replicas race at first start. Each generates a candidate and inserts it with
 * a fixed primary key and `skipDuplicates`; whichever insert lands first wins
 * and every replica then loads the stored row, so all of them sign with the
 * same CA no matter who lost the race. The losers' keys are discarded unused.
 */
@Injectable()
export class CaService implements OnModuleInit {
  private readonly logger = new Logger(CaService.name);
  private material: Promise<CaMaterial> | undefined;
  private pem: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ready();
  }

  ready(): Promise<CaMaterial> {
    this.material ??= this.load();
    return this.material;
  }

  /** PEM of the CA certificate: public, handed to agents so they can pin it. */
  async certificatePem(): Promise<string> {
    await this.ready();
    return this.pem ?? '';
  }

  async signAgentCsr(csrPem: string, clusterId: string): Promise<IssuedCertificate> {
    return signAgentCsr(await this.ready(), csrPem, clusterId);
  }

  async verifyClientCertificate(der: Buffer): Promise<VerifiedClientCertificate> {
    return verifyClientCertificate(await this.ready(), der);
  }

  async issueServerCertificate(hostnames: readonly string[]) {
    return issueServerCertificate(await this.ready(), hostnames);
  }

  private async load(): Promise<CaMaterial> {
    let row = await this.prisma.certificateAuthority.findUnique({ where: { id: CA_ROW_ID } });

    if (row === null) {
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
      row = await this.prisma.certificateAuthority.findUniqueOrThrow({ where: { id: CA_ROW_ID } });
    }

    this.pem = row.certificatePem;
    const key = this.crypto.decrypt(row.keyEncrypted, EncryptionContext.caPrivateKey());
    return loadCa(row.certificatePem, Buffer.from(key, 'base64'));
  }
}
