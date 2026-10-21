import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { CaState } from '@prisma/client';

import { CryptoService, EncryptionContext } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { AGENT_CERT_LIFETIME_MS, generateCa } from './ca';
import { CaService } from './ca.service';

export class CaRotationError extends Error {}

export interface CaRow {
  id: number;
  state: CaState;
  fingerprint: string;
  notAfter: Date;
  stateChangedAt: Date;
}

/**
 * Replaces the internal CA without re-enrolling a single agent (ADR-043, THREAT_MODEL G-12). Three
 * steps, each an operator decision, each refused until it is safe:
 *
 *  1. `stage`: a new CA is created and joins the bundle that agents receive with every certificate
 *     they renew. Nothing is signed by it yet, so nothing can break.
 *  2. `promote`: the new CA signs from now on and the old one is demoted to RETIRING (still trusted).
 *     Refused until one agent-certificate lifetime has passed since `stage`, because an agent that has
 *     not renewed since then does not trust the new CA and would reject the gateway.
 *  3. `retire`: the old CA is deleted. Refused until a lifetime has passed since `promote`, when
 *     every certificate it signed has expired.
 *
 * `--force` skips the waiting, for an operator who has checked by other means, and is logged.
 */
@Injectable()
export class CaRotationService {
  private readonly logger = new Logger(CaRotationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly ca: CaService,
  ) {}

  async status(): Promise<CaRow[]> {
    const rows = await this.prisma.certificateAuthority.findMany({ orderBy: { id: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      state: r.state,
      fingerprint: createHash('sha256')
        .update(Buffer.from(r.certificatePem.replace(/-----[^-]+-----|\s/g, ''), 'base64'))
        .digest('hex')
        .slice(0, 16),
      notAfter: r.notAfter,
      stateChangedAt: r.stateChangedAt,
    }));
  }

  async stage(): Promise<CaRow> {
    await this.ca.ready();
    const rows = await this.status();
    if (rows.some((r) => r.state !== 'ACTIVE')) {
      throw new CaRotationError(
        'a rotation is already under way; promote, retire or unstage first',
      );
    }
    const generated = await generateCa();
    const id = Math.max(...rows.map((r) => r.id)) + 1;
    await this.prisma.certificateAuthority.create({
      data: {
        id,
        certificatePem: generated.certificatePem,
        keyEncrypted: this.crypto.encrypt(
          generated.privateKeyPkcs8.toString('base64'),
          EncryptionContext.caPrivateKey(),
        ),
        notAfter: generated.notAfter,
        state: 'STAGED',
      },
    });
    this.logger.log(`staged certificate authority ${id.toString()}`);
    await this.ca.reload();
    return (await this.status()).find((r) => r.id === id) as CaRow;
  }

  /** Abandons a staged CA before it has signed anything. */
  async unstage(): Promise<void> {
    const { count } = await this.prisma.certificateAuthority.deleteMany({
      where: { state: 'STAGED' },
    });
    if (count === 0) throw new CaRotationError('there is no staged certificate authority');
    this.logger.log('unstaged the certificate authority');
    await this.ca.reload();
  }

  async promote(options: { force?: boolean; now?: Date } = {}): Promise<void> {
    const now = options.now ?? new Date();
    const rows = await this.status();
    const staged = rows.find((r) => r.state === 'STAGED');
    const active = rows.find((r) => r.state === 'ACTIVE');
    if (staged === undefined || active === undefined) {
      throw new CaRotationError('there is nothing staged to promote');
    }
    this.requireWait('promote', staged.stateChangedAt, now, options.force === true);
    // Each step only applies to the row as it was read, so two operators cannot both succeed.
    const [demoted, promoted] = await this.prisma.$transaction([
      this.prisma.certificateAuthority.updateMany({
        where: { id: active.id, state: 'ACTIVE' },
        data: { state: 'RETIRING', stateChangedAt: now },
      }),
      this.prisma.certificateAuthority.updateMany({
        where: { id: staged.id, state: 'STAGED' },
        data: { state: 'ACTIVE', stateChangedAt: now },
      }),
    ]);
    if (demoted.count !== 1 || promoted.count !== 1) {
      throw new CaRotationError(
        'the certificate authorities changed while promoting; check status',
      );
    }
    this.logger.warn(
      `promoted certificate authority ${staged.id.toString()}; ${active.id.toString()} is retiring${options.force === true ? ' (forced)' : ''}`,
    );
    await this.ca.reload();
  }

  async retire(options: { force?: boolean; now?: Date } = {}): Promise<void> {
    const now = options.now ?? new Date();
    const retiring = (await this.status()).filter((r) => r.state === 'RETIRING');
    if (retiring.length === 0)
      throw new CaRotationError('there is no retiring certificate authority');
    for (const r of retiring) {
      this.requireWait('retire', r.stateChangedAt, now, options.force === true);
    }
    await this.prisma.certificateAuthority.deleteMany({ where: { state: 'RETIRING' } });
    this.logger.warn(
      `retired certificate authority ${retiring.map((r) => r.id.toString()).join(', ')}${options.force === true ? ' (forced)' : ''}`,
    );
    await this.ca.reload();
  }

  private requireWait(step: string, since: Date, now: Date, force: boolean): void {
    const readyAt = since.getTime() + AGENT_CERT_LIFETIME_MS;
    if (!force && now.getTime() < readyAt) {
      throw new CaRotationError(
        `too early to ${step}: every agent needs one certificate renewal first; try after ${new Date(readyAt).toISOString()} (or --force)`,
      );
    }
  }
}
