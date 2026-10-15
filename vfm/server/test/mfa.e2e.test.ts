import { createHash } from 'node:crypto';

import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { TotpService } from '../src/auth/totp.service';
import { CryptoService, EncryptionContext } from '../src/crypto/crypto.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RedisService } from '../src/redis/redis.service';
import { createTestApp, readCookie, type TestApp } from './app-harness';

/**
 * End-to-end coverage of M1 day 5 — MFA and sudo mode — against real
 * PostgreSQL and Redis.
 *
 * The questions this answers that a unit test cannot: does a session that owes
 * a second factor actually get refused everywhere else, does satisfying it
 * rotate the session id as §8.3 requires, is a recovery code really single-use
 * across two HTTP requests, and does the sudo window gate a guarded route.
 */
const PASSWORD = 'canopy-vellum-ratchet-82';
const EMAIL = 'admin@vfm.local';

describe('mfa and sudo (e2e)', () => {
  let harness: TestApp;
  let prisma: PrismaService;
  let redis: RedisService;
  let crypto: CryptoService;
  let totp: TotpService;

  beforeAll(async () => {
    harness = await createTestApp();
    prisma = harness.prisma;
    redis = harness.redis;
    crypto = harness.app.get(CryptoService);
    totp = harness.app.get(TotpService);
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  const api = (): request.Agent => harness.api();

  /** An authenticated agent for a freshly created platform admin. */
  async function signedIn(): Promise<{ agent: request.Agent; csrf: string; userId: string }> {
    const token = 'setup-' + Math.random().toString(36).slice(2);
    await redis.connection.set(
      'vfm:setup:token',
      createHash('sha256').update(token, 'utf8').digest('hex'),
      'EX',
      3_600,
    );

    const agent = api();
    const response = await agent
      .post('/api/v1/auth/setup')
      .send({ token, email: EMAIL, password: PASSWORD })
      .expect(201);

    return {
      agent,
      csrf: readCookie(response.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE),
      userId: response.body.user.id as string,
    };
  }

  /**
   * Reads the stored secret the way the server does, to generate a valid code.
   *
   * `stepOffset` matters more than it looks: replay protection makes each time
   * step single-use, so a test that has already spent the current step must ask
   * for the next one rather than receive the same six digits back.
   */
  async function currentCode(userId: string, stepOffset = 0): Promise<string> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaSecretEncrypted: true },
    });
    const secret = crypto.decrypt(
      user.mfaSecretEncrypted ?? '',
      EncryptionContext.userMfaSecret(userId),
    );
    return totp.generateForTesting(secret, stepOffset);
  }

  /** Walks a user all the way through enrolment, returning their recovery codes. */
  async function enrol(
    agent: request.Agent,
    csrf: string,
    userId: string,
  ): Promise<{ recoveryCodes: string[]; csrf: string }> {
    await agent.post('/api/v1/auth/mfa/enrol').set(CSRF_HEADER, csrf).expect(200);

    const confirmed = await agent
      .post('/api/v1/auth/mfa/enrol/confirm')
      .set(CSRF_HEADER, csrf)
      .send({ code: await currentCode(userId) })
      .expect(200);

    return {
      recoveryCodes: confirmed.body.recoveryCodes as string[],
      // Enrolment rotates the session, so the CSRF token changes with it.
      csrf: readCookie(confirmed.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE),
    };
  }

  beforeEach(async () => {
    await harness.reset();
  });

  describe('enrolment', () => {
    it('returns a secret and an otpauth URI, and does not enable MFA yet', async () => {
      const { agent, csrf, userId } = await signedIn();

      const response = await agent
        .post('/api/v1/auth/mfa/enrol')
        .set(CSRF_HEADER, csrf)
        .expect(200);

      expect(response.body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(response.body.provisioningUri).toContain('otpauth://totp/');

      // Not trusted until proved: an unscanned QR must not be able to lock
      // the account out.
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.mfaEnabled).toBe(false);
      expect(user.mfaSecretEncrypted).not.toBeNull();
    });

    it('stores the secret encrypted, never in the clear', async () => {
      const { agent, csrf, userId } = await signedIn();

      const response = await agent
        .post('/api/v1/auth/mfa/enrol')
        .set(CSRF_HEADER, csrf)
        .expect(200);
      const secret = response.body.secret as string;

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

      expect(user.mfaSecretEncrypted).not.toContain(secret);
      expect(user.mfaSecretEncrypted?.startsWith('vfm1.')).toBe(true);
      // And it round-trips only under the right context.
      expect(
        crypto.decrypt(user.mfaSecretEncrypted ?? '', EncryptionContext.userMfaSecret(userId)),
      ).toBe(secret);
      expect(() =>
        crypto.decrypt(user.mfaSecretEncrypted ?? '', EncryptionContext.userMfaSecret('someone')),
      ).toThrow();
    });

    it('enables MFA and issues ten recovery codes once a code verifies', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { recoveryCodes } = await enrol(agent, csrf, userId);

      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);
      expect(recoveryCodes[0]).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.mfaEnabled).toBe(true);
    });

    it('stores recovery codes only as hashes', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { recoveryCodes } = await enrol(agent, csrf, userId);

      const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId } });

      expect(stored).toHaveLength(10);
      for (const code of recoveryCodes) {
        expect(stored.some((row) => row.codeHash === code)).toBe(false);
        expect(stored.some((row) => row.codeHash.includes(code.replace(/-/g, '')))).toBe(false);
      }
      expect(stored[0]?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects a wrong confirmation code and leaves MFA off', async () => {
      const { agent, csrf, userId } = await signedIn();
      await agent.post('/api/v1/auth/mfa/enrol').set(CSRF_HEADER, csrf).expect(200);

      await agent
        .post('/api/v1/auth/mfa/enrol/confirm')
        .set(CSRF_HEADER, csrf)
        .send({ code: '000000' })
        .expect(401);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.mfaEnabled).toBe(false);
      expect(await prisma.mfaRecoveryCode.count({ where: { userId } })).toBe(0);
    });

    it('refuses to re-enrol while MFA is on, which would strand the authenticator', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { csrf: rotated } = await enrol(agent, csrf, userId);

      await agent.post('/api/v1/auth/mfa/enrol').set(CSRF_HEADER, rotated).expect(400);
    });
  });

  describe('the login challenge gates the session (PLAN.md §8.3)', () => {
    it('reports that a factor is outstanding and refuses everything else', async () => {
      const { agent, csrf, userId } = await signedIn();
      await enrol(agent, csrf, userId);

      const fresh = api();
      const login = await fresh
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(login.body.mfaPendingReason).toBe('challenge');

      // A password alone authenticates nothing.
      const refused = await fresh.get('/api/v1/auth/me').expect(403);
      expect(refused.body.detail).toContain('multi-factor');
    });

    it('lets the challenge through, and nothing else', async () => {
      const { agent, csrf, userId } = await signedIn();
      await enrol(agent, csrf, userId);

      const fresh = api();
      await fresh.post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

      // Reachable: the endpoints needed to satisfy the factor.
      await fresh.get('/api/v1/auth/mfa').expect(200);
      // Not reachable: anything else.
      await fresh.get('/api/v1/auth/me').expect(403);
    });

    it('becomes fully authenticated once a TOTP code is accepted', async () => {
      const { agent, csrf, userId } = await signedIn();
      await enrol(agent, csrf, userId);

      const fresh = api();
      const login = await fresh
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      const loginCsrf = readCookie(login.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE);

      const answered = await fresh
        .post('/api/v1/auth/mfa/challenge')
        .set(CSRF_HEADER, loginCsrf)
        .send({ code: await currentCode(userId, 1) })
        .expect(200);

      expect(answered.body.method).toBe('totp');
      await fresh.get('/api/v1/auth/me').expect(200);
    });

    it('rotates the session id when the factor is satisfied (§8.3)', async () => {
      const { agent, csrf, userId } = await signedIn();
      await enrol(agent, csrf, userId);

      const fresh = api();
      const login = await fresh
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      const before = readCookie(login.get('Set-Cookie') ?? [], SessionService.COOKIE);
      const loginCsrf = readCookie(login.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE);

      const answered = await fresh
        .post('/api/v1/auth/mfa/challenge')
        .set(CSRF_HEADER, loginCsrf)
        .send({ code: await currentCode(userId, 1) })
        .expect(200);
      const after = readCookie(answered.get('Set-Cookie') ?? [], SessionService.COOKIE);

      expect(after).not.toBe(before);
      // The id seen while the session authenticated nothing is now dead, so a
      // copy taken during the challenge is useless.
      await api()
        .get('/api/v1/auth/me')
        .set('Cookie', `${SessionService.COOKIE}=${before}`)
        .expect(401);
    });

    it('rejects a wrong code and leaves the session gated', async () => {
      const { agent, csrf, userId } = await signedIn();
      await enrol(agent, csrf, userId);

      const fresh = api();
      const login = await fresh
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      const loginCsrf = readCookie(login.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE);

      await fresh
        .post('/api/v1/auth/mfa/challenge')
        .set(CSRF_HEADER, loginCsrf)
        .send({ code: '000000' })
        .expect(401);

      await fresh.get('/api/v1/auth/me').expect(403);
    });
  });

  describe('recovery codes', () => {
    it('satisfies the challenge and reports how many remain', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { recoveryCodes } = await enrol(agent, csrf, userId);

      const fresh = api();
      const login = await fresh
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      const loginCsrf = readCookie(login.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE);

      const answered = await fresh
        .post('/api/v1/auth/mfa/challenge')
        .set(CSRF_HEADER, loginCsrf)
        .send({ code: recoveryCodes[0] })
        .expect(200);

      expect(answered.body.method).toBe('recovery_code');
      expect(answered.body.recoveryCodesRemaining).toBe(9);
      await fresh.get('/api/v1/auth/me').expect(200);
    });

    it('is single-use: the same code fails the second time', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { recoveryCodes } = await enrol(agent, csrf, userId);
      const code = recoveryCodes[0];

      for (const expected of [200, 401]) {
        const fresh = api();
        const login = await fresh
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: PASSWORD })
          .expect(200);
        const loginCsrf = readCookie(login.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE);

        await fresh
          .post('/api/v1/auth/mfa/challenge')
          .set(CSRF_HEADER, loginCsrf)
          .send({ code })
          .expect(expected);
      }
    });

    it('accepts a code typed without its dashes or in lower case', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { recoveryCodes } = await enrol(agent, csrf, userId);

      const fresh = api();
      const login = await fresh
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      const loginCsrf = readCookie(login.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE);

      // Transcribed off paper: formatting must not matter.
      await fresh
        .post('/api/v1/auth/mfa/challenge')
        .set(CSRF_HEADER, loginCsrf)
        .send({ code: (recoveryCodes[1] ?? '').replace(/-/g, '').toLowerCase() })
        .expect(200);
    });

    it('replaces the whole set when regenerated, invalidating the old codes', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { recoveryCodes: original, csrf: rotated } = await enrol(agent, csrf, userId);

      const regenerated = await agent
        .post('/api/v1/auth/mfa/recovery-codes')
        .set(CSRF_HEADER, rotated)
        .expect(200);

      const fresh = regenerated.body.recoveryCodes as string[];
      expect(fresh).toHaveLength(10);
      expect(fresh).not.toContain(original[0]);

      const newSession = api();
      const login = await newSession
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
      const loginCsrf = readCookie(login.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE);

      await newSession
        .post('/api/v1/auth/mfa/challenge')
        .set(CSRF_HEADER, loginCsrf)
        .send({ code: original[0] })
        .expect(401);
    });
  });

  describe('sudo mode (PLAN.md §8.3 line 405)', () => {
    it('opens the window with the account password', async () => {
      const { agent, csrf } = await signedIn();

      const response = await agent
        .post('/api/v1/auth/sudo')
        .set(CSRF_HEADER, csrf)
        .send({ password: PASSWORD })
        .expect(200);

      expect(Date.parse(response.body.expiresAt as string)).toBeGreaterThan(Date.now());
    });

    it('opens the window with a second factor', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { csrf: rotated } = await enrol(agent, csrf, userId);

      await agent
        .post('/api/v1/auth/sudo')
        .set(CSRF_HEADER, rotated)
        .send({ code: await currentCode(userId, 1) })
        .expect(200);
    });

    it('refuses a wrong password', async () => {
      const { agent, csrf } = await signedIn();

      await agent
        .post('/api/v1/auth/sudo')
        .set(CSRF_HEADER, csrf)
        .send({ password: 'not-the-password' })
        .expect(401);
    });

    it('requires exactly one of a password or a code', async () => {
      const { agent, csrf } = await signedIn();

      // Accepting both and preferring one would make the weaker factor
      // sufficient whenever a client sent it.
      await agent
        .post('/api/v1/auth/sudo')
        .set(CSRF_HEADER, csrf)
        .send({ password: PASSWORD, code: '123456' })
        .expect(422);
      await agent.post('/api/v1/auth/sudo').set(CSRF_HEADER, csrf).send({}).expect(422);
    });

    it('guards a route marked @RequiresSudo once the window lapses', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { csrf: rotated } = await enrol(agent, csrf, userId);

      // Regenerating recovery codes is sudo-guarded, and setup counted as a
      // re-authentication, so it works now.
      await agent.post('/api/v1/auth/mfa/recovery-codes').set(CSRF_HEADER, rotated).expect(200);

      // Age the session's re-authentication past the five-minute window.
      await ageSudo(userId);

      const refused = await agent
        .post('/api/v1/auth/mfa/recovery-codes')
        .set(CSRF_HEADER, rotated)
        .expect(403);
      expect(refused.body.detail).toContain('re-authentication');

      // And re-authenticating opens it again.
      await agent
        .post('/api/v1/auth/sudo')
        .set(CSRF_HEADER, rotated)
        .send({ password: PASSWORD })
        .expect(200);
      await agent.post('/api/v1/auth/mfa/recovery-codes').set(CSRF_HEADER, rotated).expect(200);
    });
  });

  describe('disabling MFA', () => {
    it('is refused for a user obliged to have it', async () => {
      // The admin created by setup is a platform admin, for whom §8.3 makes
      // MFA mandatory — they must not be able to opt out.
      const { agent, csrf, userId } = await signedIn();
      const { csrf: rotated } = await enrol(agent, csrf, userId);

      const refused = await agent
        .delete('/api/v1/auth/mfa')
        .set(CSRF_HEADER, rotated)
        .send({ code: await currentCode(userId, 1) })
        .expect(400);

      expect(refused.body.detail).toContain('required for your role');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mfaEnabled).toBe(
        true,
      );
    });

    it('destroys the secret and the codes for a user who may disable it', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { csrf: rotated } = await enrol(agent, csrf, userId);

      // Drop the obligation so the operation is permitted at all.
      await prisma.user.update({ where: { id: userId }, data: { isPlatformAdmin: false } });

      await agent
        .delete('/api/v1/auth/mfa')
        .set(CSRF_HEADER, rotated)
        .send({ code: await currentCode(userId, 1) })
        .expect(204);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.mfaEnabled).toBe(false);
      expect(user.mfaSecretEncrypted).toBeNull();
      expect(user.mfaLastTimeStep).toBeNull();
      expect(await prisma.mfaRecoveryCode.count({ where: { userId } })).toBe(0);
    });

    it('refuses a wrong code', async () => {
      const { agent, csrf, userId } = await signedIn();
      const { csrf: rotated } = await enrol(agent, csrf, userId);
      await prisma.user.update({ where: { id: userId }, data: { isPlatformAdmin: false } });

      await agent
        .delete('/api/v1/auth/mfa')
        .set(CSRF_HEADER, rotated)
        .send({ code: '000000' })
        .expect(401);

      expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).mfaEnabled).toBe(
        true,
      );
    });
  });

  describe('the enrolment obligation', () => {
    it('holds a platform admin without MFA at the enrolment endpoints', async () => {
      // §8.3 makes MFA required for Owner/Admin by default, so an admin who
      // has not enrolled cannot simply carry on.
      await signedIn();

      const fresh = api();
      const login = await fresh
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(login.body.mfaPendingReason).toBe('enrolment');

      const refused = await fresh.get('/api/v1/auth/me').expect(403);
      expect(refused.body.detail).toContain('set up');

      // Enrolment itself stays reachable, or the account would be unusable.
      await fresh.get('/api/v1/auth/mfa').expect(200);
    });

    it('lets a user with no obligation straight in', async () => {
      const { userId } = await signedIn();
      await prisma.user.update({ where: { id: userId }, data: { isPlatformAdmin: false } });

      const fresh = api();
      const login = await fresh
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(login.body.mfaPendingReason).toBeNull();
      await fresh.get('/api/v1/auth/me').expect(200);
    });
  });

  /** Rewrites the session's re-authentication time to push it out of the window. */
  async function ageSudo(userId: string): Promise<void> {
    const ids = await redis.connection.smembers(`vfm:sess:user:${userId}`);
    for (const id of ids) {
      const raw = await redis.connection.get(`vfm:sess:${id}`);
      if (raw === null) {
        continue;
      }
      const record = JSON.parse(raw) as { lastReauthAt: number };
      record.lastReauthAt = Date.now() - 10 * 60 * 1_000;
      await redis.connection.set(`vfm:sess:${id}`, JSON.stringify(record), 'EX', 3_600);
    }
  }
});
