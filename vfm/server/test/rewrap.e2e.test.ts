import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '../src/common/uuid';
import type { Env } from '../src/config/env.schema';
import { CryptoService, EncryptionContext } from '../src/crypto/crypto.service';
import { RewrapService } from '../src/crypto/rewrap.service';
import { createTestApp, type TestApp } from './app-harness';

/**
 * G-9 / day 39: a master key is retired by moving every stored secret onto the new one first.
 * Real Postgres; the "old" key is the harness key and the "new" one is a different key that accepts it.
 */
const cryptoWith = (primary: string, previous: string[]) =>
  new CryptoService({
    VFM_MASTER_KEY: primary,
    VFM_MASTER_KEY_PREVIOUS: previous,
  } as unknown as Env);

describe('master key re-wrap (e2e)', () => {
  let harness: TestApp;
  let oldCrypto: CryptoService;
  let newCrypto: CryptoService;
  const oldKey = Buffer.alloc(32, 9).toString('base64');
  const newKey = Buffer.alloc(32, 7).toString('base64');

  beforeAll(async () => {
    harness = await createTestApp();
    // The harness key is the primary ("new") key. Rows are written under a different, older key. The
    // shared CA row is deliberately never re-written here: other suites running in parallel read it.
    newCrypto = cryptoWith(newKey, [oldKey]);
    oldCrypto = cryptoWith(oldKey, []);
    await harness.reset();
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  async function seed() {
    const user = await harness.prisma.user.create({
      data: {
        id: newId(),
        email: `u${Math.random().toString(36).slice(2)}@example.com`,
        passwordHash: 'x',
        mfaSecretEncrypted: null,
      },
    });
    await harness.prisma.user.update({
      where: { id: user.id },
      data: {
        mfaSecretEncrypted: oldCrypto.encrypt(
          'JBSWY3DPEHPK3PXP',
          EncryptionContext.userMfaSecret(user.id),
        ),
      },
    });
    const org = await harness.prisma.organization.create({
      data: { id: newId(), name: 'A', slug: `a${Math.random().toString(36).slice(2, 8)}` },
    });
    const channelId = newId();
    await harness.prisma.inOrg(org.id, () =>
      harness.prisma.notificationChannel.create({
        data: {
          id: channelId,
          orgId: org.id,
          name: 'hook',
          type: 'WEBHOOK',
          configEncrypted: oldCrypto.encrypt(
            '{"url":"https://x.example"}',
            EncryptionContext.notificationChannelConfig(channelId),
          ),
        },
      }),
    );
    return { user, org, channelId };
  }

  it('reports without writing on a dry run, then moves everything onto the primary key, idempotently', async () => {
    const { user, org, channelId } = await seed();
    const svc = new RewrapService(harness.prisma, newCrypto);

    const dry = await svc.run({ dryRun: true });
    expect(dry.failures).toEqual([]);
    expect(Object.values(dry.columns).every((c) => c.rewritten === 0)).toBe(true);
    expect(dry.columns['users.mfa_secret_encrypted']?.stale).toBeGreaterThanOrEqual(1);
    const stillOld = await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(newCrypto.needsRewrap(stillOld.mfaSecretEncrypted ?? '')).toBe(true);

    const first = await svc.run();
    expect(first.failures).toEqual([]);
    for (const column of ['users.mfa_secret_encrypted', 'notification_channels.config_encrypted']) {
      expect(first.columns[column]?.stale, column).toBeGreaterThanOrEqual(1);
      expect(first.columns[column]?.rewritten, column).toBe(first.columns[column]?.stale);
    }

    const u = await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(newCrypto.needsRewrap(u.mfaSecretEncrypted ?? '')).toBe(false);
    expect(
      newCrypto.decrypt(u.mfaSecretEncrypted ?? '', EncryptionContext.userMfaSecret(user.id)),
    ).toBe('JBSWY3DPEHPK3PXP');
    const ch = await harness.prisma.inOrg(org.id, () =>
      harness.prisma.notificationChannel.findUniqueOrThrow({ where: { id: channelId } }),
    );
    expect(
      newCrypto.decrypt(ch.configEncrypted, EncryptionContext.notificationChannelConfig(channelId)),
    ).toContain('x.example');
    const ca = await harness.prisma.unscoped('test', () =>
      harness.prisma.certificateAuthority.findFirstOrThrow(),
    );
    expect(newCrypto.needsRewrap(ca.keyEncrypted)).toBe(false);

    // With the old key gone, everything still opens; a second run has nothing to do.
    const retired = cryptoWith(newKey, []);
    expect(() => retired.decrypt(ca.keyEncrypted, EncryptionContext.caPrivateKey())).not.toThrow();
    const second = await new RewrapService(harness.prisma, retired).run();
    expect(second.failures).toEqual([]);
    expect(Object.values(second.columns).every((c) => c.stale === 0)).toBe(true);
  });

  it('leaves a value it cannot open alone and says so', async () => {
    const { user } = await seed();
    const stranger = cryptoWith(Buffer.alloc(32, 3).toString('base64'), []);
    const before = (await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .mfaSecretEncrypted;
    const report = await new RewrapService(harness.prisma, stranger).run();
    expect(report.failures.some((f) => f.includes(user.id))).toBe(true);
    const after = (await harness.prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
      .mfaSecretEncrypted;
    expect(after).toBe(before);
  });
});
