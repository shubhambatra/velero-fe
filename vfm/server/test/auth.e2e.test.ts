import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { ProblemExceptionFilter } from '../src/common/problem.filter';
import { requestIdMiddleware } from '../src/common/request-id';
import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { SetupService } from '../src/auth/setup.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/**
 * End-to-end coverage of the M1 day 4 authentication flow against **real**
 * PostgreSQL and Redis from the dev stack.
 *
 * The unit tests cover the pieces; this covers the thing the plan actually
 * asks for (PLAN.md §16 day 4) — that a fresh install can be claimed exactly
 * once with the printed token, that the resulting session works, that CSRF is
 * enforced on state-changing calls, and that none of it can be bypassed.
 *
 * It runs against `vfm_test`, a separate database, and truncates `users`
 * between tests. It needs `make dev-up`; without it the suite is skipped
 * rather than reported as passing.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://vfm:vfm-dev-password@localhost:55432/vfm_test?schema=public';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:56379/15';

const PASSWORD = 'canopy-vellum-ratchet-82';
const EMAIL = 'admin@vfm.local';

describe('auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let setup: SetupService;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.REDIS_URL = REDIS_URL;
    process.env.NODE_ENV = 'test';
    // pino logs every request; the assertions are what matter here.
    process.env.LOG_LEVEL = 'fatal';
    Logger.overrideLogger(false);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    // The same middleware and filters main.ts installs, so the behaviour under
    // test is the behaviour that ships.
    app.use(requestIdMiddleware);
    app.use(cookieParser());
    app.use(json({ limit: '1mb' }));
    app.useGlobalFilters(new ProblemExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });

    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    setup = app.get(SetupService);
  }, 60_000);

  afterAll(async () => {
    await prisma.user.deleteMany();
    await redis.connection.flushdb();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
    await redis.connection.flushdb();
  });

  /** Issues a fresh setup token the way bootstrap does, returning the plaintext. */
  async function issueSetupToken(): Promise<string> {
    // onApplicationBootstrap logs the token; re-running it here gives the test
    // the same code path without parsing log output.
    await setup.onApplicationBootstrap();
    // The plaintext only exists in the log, so generate a known one instead by
    // round-tripping through the service's own storage.
    const token = 'test-setup-token-' + Math.random().toString(36).slice(2);
    const { createHash } = await import('node:crypto');
    await redis.connection.set(
      'vfm:setup:token',
      createHash('sha256').update(token, 'utf8').digest('hex'),
      'EX',
      3_600,
    );
    return token;
  }

  const api = (): request.Agent => request.agent(app.getHttpServer() as never);

  describe('first-time setup', () => {
    it('reports that setup is open while no user exists', async () => {
      const response = await api().get('/api/v1/auth/setup').expect(200);

      expect(response.body).toStrictEqual({ open: true });
    });

    it('creates the first platform admin with a valid token and signs them in', async () => {
      const token = await issueSetupToken();

      const response = await api()
        .post('/api/v1/auth/setup')
        .send({ token, email: EMAIL, password: PASSWORD, name: 'Admin' })
        .expect(201);

      expect(response.body.user).toMatchObject({
        email: EMAIL,
        name: 'Admin',
        isPlatformAdmin: true,
        mfaEnabled: false,
      });
      // No hash, ever, in a response body.
      expect(JSON.stringify(response.body)).not.toContain('argon2');
      expect(response.body.user.passwordHash).toBeUndefined();

      const cookies = response.get('Set-Cookie') ?? [];
      expect(cookies.join(';')).toContain(`${SessionService.COOKIE}=`);
      expect(cookies.join(';')).toContain(`${SessionService.CSRF_COOKIE}=`);
      // PLAN.md §8.3: the session cookie is httpOnly and SameSite=Lax.
      const sessionCookie = cookies.find((c) => c.startsWith(SessionService.COOKIE));
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
      // The CSRF cookie must be readable by the SPA, so it is NOT httpOnly.
      expect(cookies.find((c) => c.startsWith(SessionService.CSRF_COOKIE))).not.toContain(
        'HttpOnly',
      );
    });

    it('stores an argon2id hash, never the password', async () => {
      const token = await issueSetupToken();
      await api()
        .post('/api/v1/auth/setup')
        .send({ token, email: EMAIL, password: PASSWORD })
        .expect(201);

      const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });

      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(PASSWORD);
      expect(user.isPlatformAdmin).toBe(true);
    });

    it('burns the token: the same one cannot be used twice', async () => {
      const token = await issueSetupToken();

      await api()
        .post('/api/v1/auth/setup')
        .send({ token, email: EMAIL, password: PASSWORD })
        .expect(201);

      await api()
        .post('/api/v1/auth/setup')
        .send({ token, email: 'second@vfm.local', password: PASSWORD })
        .expect(401);

      expect(await prisma.user.count()).toBe(1);
    });

    it('rejects a wrong token without creating anything', async () => {
      await issueSetupToken();

      await api()
        .post('/api/v1/auth/setup')
        .send({ token: 'not-the-token', email: EMAIL, password: PASSWORD })
        .expect(401);

      expect(await prisma.user.count()).toBe(0);
    });

    it('rejects a password that fails policy, without burning the token', async () => {
      const token = await issueSetupToken();

      const response = await api()
        .post('/api/v1/auth/setup')
        .send({ token, email: EMAIL, password: 'password' })
        .expect(422);

      expect(response.body.detail).toContain('at least 12 characters');
      expect(response.body.detail).toContain('commonly breached');

      // The operator gets to try again with the same token.
      await api()
        .post('/api/v1/auth/setup')
        .send({ token, email: EMAIL, password: PASSWORD })
        .expect(201);
    });

    it('closes permanently once a user exists — there is no open self-signup', async () => {
      const token = await issueSetupToken();
      await api()
        .post('/api/v1/auth/setup')
        .send({ token, email: EMAIL, password: PASSWORD })
        .expect(201);

      expect((await api().get('/api/v1/auth/setup').expect(200)).body).toStrictEqual({
        open: false,
      });

      // Even with a freshly issued token, bootstrap refuses to mint one while
      // a user exists, so there is nothing to present.
      await setup.onApplicationBootstrap();
      expect(await redis.connection.get('vfm:setup:token')).toBeNull();
    });

    it('returns problem+json with a request id for a validation failure', async () => {
      const response = await api()
        .post('/api/v1/auth/setup')
        .send({ token: 'x', email: 'not-an-email', password: PASSWORD })
        .expect(422);

      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.headers['x-request-id']).toBeTruthy();
      expect(response.body.status).toBe(422);
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      const token = await issueSetupToken();
      await api()
        .post('/api/v1/auth/setup')
        .send({ token, email: EMAIL, password: PASSWORD })
        .expect(201);
    });

    it('signs in with the right password and returns the user', async () => {
      const response = await api()
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(response.body.user.email).toBe(EMAIL);
      expect(response.body.mfaRequired).toBe(false);
    });

    it('accepts the email in any case', async () => {
      await api()
        .post('/api/v1/auth/login')
        .send({ email: 'ADMIN@VFM.LOCAL', password: PASSWORD })
        .expect(200);
    });

    it('rejects a wrong password', async () => {
      await api()
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: 'canopy-vellum-ratchet-83' })
        .expect(401);
    });

    it('gives the same answer for an unknown account as for a wrong password', async () => {
      const unknown = await api()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@vfm.local', password: PASSWORD })
        .expect(401);

      const wrong = await api()
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: 'wrong-password-here' })
        .expect(401);

      // Identical bodies: nothing here distinguishes "no such user" from
      // "wrong password" (PLAN.md §8.3).
      expect(unknown.body.detail).toBe(wrong.body.detail);
      expect(unknown.body.title).toBe(wrong.body.title);
    });

    it('refuses a disabled account, with the same message', async () => {
      await prisma.user.update({ where: { email: EMAIL }, data: { disabledAt: new Date() } });

      const response = await api()
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(401);

      expect(response.body.detail).toBe('invalid email or password');
    });

    it('records last_login_at', async () => {
      const before = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
      expect(before.lastLoginAt).toBeNull();

      await api().post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(200);

      const after = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
      expect(after.lastLoginAt).not.toBeNull();
    });

    it('locks the account after ten failures and answers 429 with Retry-After', async () => {
      for (let i = 0; i < 10; i += 1) {
        await api()
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: `wrong-${i.toString()}-attempt` });
      }

      const response = await api()
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(429);

      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      // Even the *correct* password is refused while the lock stands.
      expect(response.body.detail).toContain('too many failed attempts');
    }, 60_000);
  });

  describe('authenticated requests', () => {
    let agent: request.Agent;
    let csrfToken: string;

    beforeEach(async () => {
      const token = await issueSetupToken();
      agent = api();
      const response = await agent
        .post('/api/v1/auth/setup')
        .send({ token, email: EMAIL, password: PASSWORD })
        .expect(201);

      csrfToken = readCookie(response.get('Set-Cookie') ?? [], SessionService.CSRF_COOKIE);
    });

    it('serves /auth/me from the session cookie', async () => {
      const response = await agent.get('/api/v1/auth/me').expect(200);

      expect(response.body.user.email).toBe(EMAIL);
    });

    it('refuses /auth/me without a session', async () => {
      await api().get('/api/v1/auth/me').expect(401);
    });

    it('refuses /auth/me with a forged session cookie', async () => {
      await api()
        .get('/api/v1/auth/me')
        .set('Cookie', `${SessionService.COOKIE}=not-a-real-session-id`)
        .expect(401);
    });

    describe('CSRF (PLAN.md §8.3)', () => {
      it('rejects a state-changing request with no token', async () => {
        await agent.delete('/api/v1/auth/sessions').expect(403);
      });

      it('rejects a state-changing request with the wrong token', async () => {
        await agent.delete('/api/v1/auth/sessions').set(CSRF_HEADER, 'not-the-token').expect(403);
      });

      it('accepts a state-changing request with the matching token', async () => {
        await agent.delete('/api/v1/auth/sessions').set(CSRF_HEADER, csrfToken).expect(200);
      });

      it('does not require a token for a safe method', async () => {
        await agent.get('/api/v1/auth/me').expect(200);
      });
    });

    it('signs out, and the session stops working immediately', async () => {
      await agent.post('/api/v1/auth/logout').set(CSRF_HEADER, csrfToken).expect(204);

      await agent.get('/api/v1/auth/me').expect(401);
    });

    it('signs out everywhere while keeping the calling session alive', async () => {
      // A second browser for the same user.
      const other = api();
      await other.post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD }).expect(200);
      await other.get('/api/v1/auth/me').expect(200);

      const response = await agent
        .delete('/api/v1/auth/sessions')
        .set(CSRF_HEADER, csrfToken)
        .expect(200);

      expect(response.body.revoked).toBe(1);
      await agent.get('/api/v1/auth/me').expect(200);
      await other.get('/api/v1/auth/me').expect(401);
    });

    it('revokes the session the moment the account is disabled', async () => {
      // This is why sessions live in Redis and the user row is re-read on
      // every request (PLAN.md §9).
      await agent.get('/api/v1/auth/me').expect(200);

      await prisma.user.update({ where: { email: EMAIL }, data: { disabledAt: new Date() } });

      await agent.get('/api/v1/auth/me').expect(401);
    });
  });

  describe('deny by default', () => {
    it('leaves the health probes public', async () => {
      await api().get('/healthz').expect(200);
    });

    it('requires a session for anything not marked public', async () => {
      // SessionGuard is global, so a route is protected unless @Public().
      await api().get('/api/v1/auth/me').expect(401);
      await api().delete('/api/v1/auth/sessions').expect(401);
    });
  });
});

function readCookie(cookies: string[], name: string): string {
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (match === undefined) {
    throw new Error(`cookie ${name} was not set`);
  }
  const value = match.slice(name.length + 1).split(';')[0];
  return decodeURIComponent(value ?? '');
}
