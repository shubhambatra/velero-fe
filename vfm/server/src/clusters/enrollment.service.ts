import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import { CaService } from '../ca/ca.service';
import { CertificateError } from '../ca/ca';
import { newId } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';

export const BOOTSTRAP_TOKEN_TTL_MS = 24 * 3_600_000;

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** One answer for every way a token can be wrong, so it is not an oracle. */
const refuseToken = (): UnauthorizedException =>
  new UnauthorizedException('invalid or expired bootstrap token');

export interface EnrollResult {
  clusterId: string;
  certificatePem: string;
  caBundlePem: string;
  notAfter: Date;
}

/**
 * Bootstrap tokens, `Enroll` and `RenewCertificate` (PLAN.md §5.1).
 *
 * Plain methods rather than gRPC handlers so the whole flow is testable
 * without a network; `gateway/` adapts them to the wire.
 */
@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ca: CaService,
  ) {}

  /**
   * Issues a fresh token for a cluster and invalidates any earlier unused one,
   * so at most one enrollment credential is live per cluster. The secret is
   * returned once; only its hash is stored.
   */
  async issueToken(orgId: string, clusterId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS);

    await this.prisma.inOrg(orgId, () =>
      this.prisma.$transaction([
        this.prisma.clusterBootstrapToken.deleteMany({ where: { clusterId, usedAt: null } }),
        this.prisma.clusterBootstrapToken.create({
          data: { id: newId(), orgId, clusterId, tokenHash: sha256(token), expiresAt },
        }),
      ]),
    );
    return { token, expiresAt };
  }

  /**
   * Redeems a bootstrap token for a client certificate.
   *
   * The token is burned by a conditional UPDATE inside the same transaction that
   * records the certificate, so two concurrent enrollments with one token cannot
   * both succeed and a failure after burning cannot leave a certificate without
   * a record (or a record without a certificate).
   */
  async enroll(input: {
    token: string;
    csrPem: string;
    clusterFingerprint: string;
    agentVersion: string;
  }): Promise<EnrollResult> {
    if (input.token === '' || input.clusterFingerprint.trim() === '') {
      throw refuseToken();
    }

    const tokenHash = sha256(input.token);
    const record = await this.prisma.unscoped(
      'a bootstrap token identifies its cluster and org',
      () =>
        this.prisma.clusterBootstrapToken.findUnique({
          where: { tokenHash },
          include: {
            cluster: { select: { id: true, orgId: true, status: true, fingerprint: true } },
          },
        }),
    );

    if (
      record === null ||
      record.usedAt !== null ||
      record.expiresAt.getTime() <= Date.now() ||
      record.cluster.status === 'DISABLED'
    ) {
      throw refuseToken();
    }
    const { cluster } = record;

    // A cluster that was enrolled before only accepts the same cluster again.
    // Moving an agent to a different cluster needs an explicit reset by an admin.
    if (cluster.fingerprint !== null && cluster.fingerprint !== input.clusterFingerprint) {
      this.logger.warn(`enrollment refused: fingerprint mismatch for cluster ${cluster.id}`);
      throw refuseToken();
    }

    let issued;
    try {
      issued = await this.ca.signAgentCsr(input.csrPem, cluster.id);
    } catch (error) {
      if (error instanceof CertificateError) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }

    const burned = await this.prisma.unscoped(
      'a bootstrap token identifies its cluster and org',
      () =>
        this.prisma.$transaction(async (tx) => {
          const claim = await tx.clusterBootstrapToken.updateMany({
            where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
            data: { usedAt: new Date() },
          });
          if (claim.count !== 1) {
            return false;
          }
          await tx.agentCertificate.create({
            data: {
              id: newId(),
              orgId: cluster.orgId,
              clusterId: cluster.id,
              serial: issued.serial,
              notBefore: issued.notBefore,
              notAfter: issued.notAfter,
            },
          });
          await tx.cluster.update({
            where: { id: cluster.id },
            data: {
              status: 'ENROLLED',
              fingerprint: input.clusterFingerprint,
              agentVersion: input.agentVersion === '' ? null : input.agentVersion,
            },
          });
          return true;
        }),
    );

    if (!burned) {
      throw refuseToken();
    }

    return {
      clusterId: cluster.id,
      certificatePem: issued.certificatePem,
      caBundlePem: await this.ca.certificatePem(),
      notAfter: issued.notAfter,
    };
  }

  /**
   * Authenticates a presented client certificate (DER) and checks the
   * deny-list: the serial must be one we issued, not revoked, and its cluster
   * must not be disabled. Anything unknown is denied, which is what makes
   * deleting a cluster (and its certificate rows) a revocation too.
   */
  async authenticate(
    der: Buffer,
  ): Promise<{ clusterId: string; orgId: string; serial: string; notAfter: Date }> {
    let verified;
    try {
      verified = await this.ca.verifyClientCertificate(der);
    } catch (error) {
      if (error instanceof CertificateError) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }

    const row = await this.prisma.unscoped(
      'an agent certificate identifies its cluster and org',
      () =>
        this.prisma.agentCertificate.findUnique({
          where: { serial: verified.serial },
          include: { cluster: { select: { id: true, status: true } } },
        }),
    );

    if (
      row === null ||
      row.revokedAt !== null ||
      row.clusterId !== verified.clusterId ||
      row.notAfter.getTime() <= Date.now() ||
      row.cluster.status === 'DISABLED'
    ) {
      throw new UnauthorizedException('the client certificate has been revoked');
    }
    return {
      clusterId: row.clusterId,
      orgId: row.orgId,
      serial: row.serial,
      notAfter: row.notAfter,
    };
  }

  /** Issues a replacement certificate; the current one stays valid until it expires. */
  async renew(der: Buffer, csrPem: string): Promise<EnrollResult> {
    const { clusterId, orgId } = await this.authenticate(der);

    let issued;
    try {
      issued = await this.ca.signAgentCsr(csrPem, clusterId);
    } catch (error) {
      if (error instanceof CertificateError) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }

    await this.prisma.inOrg(orgId, () =>
      this.prisma.agentCertificate.create({
        data: {
          id: newId(),
          orgId,
          clusterId,
          serial: issued.serial,
          notBefore: issued.notBefore,
          notAfter: issued.notAfter,
        },
      }),
    );

    return {
      clusterId,
      certificatePem: issued.certificatePem,
      caBundlePem: await this.ca.certificatePem(),
      notAfter: issued.notAfter,
    };
  }

  /** Adds every live certificate of a cluster to the deny-list. */
  async revokeCertificates(orgId: string, clusterId: string): Promise<number> {
    const result = await this.prisma.inOrg(orgId, () =>
      this.prisma.agentCertificate.updateMany({
        where: { clusterId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    return result.count;
  }
}
