import 'reflect-metadata';

import { createHash, X509Certificate } from 'node:crypto';

import * as x509 from '@peculiar/x509';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { CaService } from '../src/ca/ca.service';
import { CryptoService } from '../src/crypto/crypto.service';
import { EnrollmentService } from '../src/clusters/enrollment.service';
import { createTestApp, type TestApp } from './app-harness';

/**
 * End-to-end coverage of M2 day 11 — clusters, bootstrap tokens, the internal CA
 * and the Enroll / RenewCertificate logic — against real PostgreSQL and Redis.
 * The gRPC transport that carries these calls is covered separately; here the
 * rules are exercised directly so each can be asserted precisely.
 */
const PASSWORD = 'canopy-vellum-ratchet-82';
const FINGERPRINT = 'f3a1c2d4-kube-system-uid-0001';

async function newCsr(): Promise<string> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=agent',
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  return csr.toString('pem');
}

const der = (pem: string): Buffer => Buffer.from(new X509Certificate(pem).raw);

describe('clusters and enrollment (e2e)', () => {
  let harness: TestApp;
  let sessions: SessionService;
  let enrollment: EnrollmentService;

  beforeAll(async () => {
    harness = await createTestApp();
    sessions = harness.app.get(SessionService);
    enrollment = harness.app.get(EnrollmentService);
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  const api = (): request.Agent => harness.api();

  interface Actor {
    userId: string;
    sessionId: string;
    call: (
      method: 'get' | 'post' | 'patch' | 'put' | 'delete',
      path: string,
      body?: object,
    ) => request.Test;
  }

  async function actAs(userId: string): Promise<Actor> {
    const created = await sessions.create({ userId, ip: '127.0.0.1', userAgent: 'vitest' });
    const cookie = `${SessionService.COOKIE}=${created.id}; ${SessionService.CSRF_COOKIE}=${created.csrfToken}`;
    return {
      userId,
      sessionId: created.id,
      call: (method, path, body) => {
        const req = api()
          [method](`/api/v1${path}`)
          .set('Cookie', cookie)
          .set(CSRF_HEADER, created.csrfToken);
        return body === undefined ? req : req.send(body);
      },
    };
  }

  async function platformAdmin(): Promise<Actor> {
    const token = 'setup-' + Math.random().toString(36).slice(2);
    await harness.redis.connection.set(
      'vfm:setup:token',
      createHash('sha256').update(token, 'utf8').digest('hex'),
      'EX',
      3_600,
    );
    const res = await api()
      .post('/api/v1/auth/setup')
      .send({ token, email: 'root@vfm.local', password: PASSWORD })
      .expect(201);
    return actAs(res.body.user.id as string);
  }

  async function createOrg(admin: Actor, slug: string): Promise<string> {
    const res = await admin.call('post', '/orgs', { name: `Org ${slug}`, slug }).expect(201);
    const orgId = res.body.id as string;
    await admin.call('post', '/me/active-org', { orgId }).expect(204);
    return orgId;
  }

  async function addMember(owner: Actor, orgId: string, email: string): Promise<Actor> {
    await owner.call('post', `/orgs/${orgId}/invites`, { email, orgRole: 'MEMBER' }).expect(201);
    const res = await api()
      .post('/api/v1/invites/register')
      .send({ token: harness.mail.tokenFor(email), password: PASSWORD, name: email })
      .expect(201);
    const actor = await actAs(res.body.user.id as string);
    await actor.call('post', '/me/active-org', { orgId }).expect(204);
    return actor;
  }

  interface Created {
    cluster: { id: string; name: string; status: string };
    bootstrapToken: string;
    expiresAt: string;
    installCommand: string;
  }

  async function addCluster(admin: Actor, orgId: string, name = 'prod-eu'): Promise<Created> {
    const res = await admin.call('post', `/orgs/${orgId}/clusters`, { name }).expect(201);
    return res.body as Created;
  }

  async function enroll(token: string, fingerprint = FINGERPRINT) {
    return enrollment.enroll({
      token,
      csrPem: await newCsr(),
      clusterFingerprint: fingerprint,
      agentVersion: '0.1.0',
    });
  }

  describe('adding a cluster', () => {
    it('creates a PENDING cluster and returns the token and install command once', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');

      const created = await addCluster(admin, orgId);

      expect(created.cluster.status).toBe('PENDING');
      expect(created.bootstrapToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new Date(created.expiresAt).getTime() - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
      expect(created.installCommand).toContain(`--set enrollment.token=${created.bootstrapToken}`);
      expect(created.installCommand).toContain('BEGIN CERTIFICATE');

      // Only a hash is stored, and reading the cluster back never returns the secret.
      const stored = await harness.prisma.unscoped('test', () =>
        harness.prisma.clusterBootstrapToken.findMany(),
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.tokenHash).not.toBe(created.bootstrapToken);
      const read = await admin.call('get', `/orgs/${orgId}/clusters/${created.cluster.id}`);
      expect(JSON.stringify(read.body)).not.toContain(created.bootstrapToken);
    });

    it('refuses a duplicate name within the org but allows it in another org', async () => {
      const admin = await platformAdmin();
      const orgA = await createOrg(admin, 'alpha');
      await addCluster(admin, orgA, 'shared');
      await admin.call('post', `/orgs/${orgA}/clusters`, { name: 'shared' }).expect(409);

      const orgB = await createOrg(admin, 'beta');
      await addCluster(admin, orgB, 'shared');
    });

    it('is for org owners and admins, and needs a recent re-authentication', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const member = await addMember(admin, orgId, 'dev@acme.test');
      await member.call('post', `/orgs/${orgId}/clusters`, { name: 'x' }).expect(403);

      await sessions.update(admin.sessionId, { lastReauthAt: Date.now() - 10 * 60 * 1_000 });
      const res = await admin.call('post', `/orgs/${orgId}/clusters`, { name: 'x' }).expect(403);
      expect(res.body.sudoRequired).toBe(true);
    });

    it('rejects names and labels that are not plain', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      for (const name of ['', ' ', '../etc', 'a'.repeat(64), 'x\ny', '<script>']) {
        await admin.call('post', `/orgs/${orgId}/clusters`, { name }).expect(422);
      }
    });

    it('does not record the bootstrap token in the audit log', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const created = await addCluster(admin, orgId);
      const rows = await harness.prisma.unscoped('test', () =>
        harness.prisma.auditEvent.findMany(),
      );
      expect(JSON.stringify(rows)).not.toContain(created.bootstrapToken);
      expect(rows.some((r) => r.action === 'POST /orgs/:orgId/clusters')).toBe(true);
    });
  });

  describe('visibility', () => {
    it('lists only clusters the caller can read; owners see all', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const seen = await addCluster(admin, orgId, 'seen');
      await addCluster(admin, orgId, 'hidden');
      const dev = await addMember(admin, orgId, 'dev@acme.test');

      expect((await dev.call('get', `/orgs/${orgId}/clusters`).expect(200)).body.clusters).toEqual(
        [],
      );

      await admin
        .call('post', `/clusters/${seen.cluster.id}/role-bindings`, {
          subjectType: 'USER',
          subjectId: dev.userId,
          role: 'VIEWER',
          scope: { type: 'CLUSTER' },
        })
        .expect(201);

      const mine = (await dev.call('get', `/orgs/${orgId}/clusters`).expect(200)).body as {
        clusters: { name: string }[];
      };
      expect(mine.clusters.map((c) => c.name)).toEqual(['seen']);
      expect(
        (await admin.call('get', `/orgs/${orgId}/clusters`).expect(200)).body.clusters,
      ).toHaveLength(2);
    });

    it('answers 404, not 403, for a cluster the caller cannot see, and 403 when they can', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const c = await addCluster(admin, orgId);
      const dev = await addMember(admin, orgId, 'dev@acme.test');
      await dev.call('get', `/orgs/${orgId}/clusters/${c.cluster.id}`).expect(404);

      await admin
        .call('post', `/clusters/${c.cluster.id}/role-bindings`, {
          subjectType: 'USER',
          subjectId: dev.userId,
          role: 'VIEWER',
          scope: { type: 'CLUSTER' },
        })
        .expect(201);
      await dev.call('get', `/orgs/${orgId}/clusters/${c.cluster.id}`).expect(200);
      await dev.call('patch', `/orgs/${orgId}/clusters/${c.cluster.id}`, { name: 'z' }).expect(403);
    });

    it('keeps one org’s clusters invisible and immutable from another org', async () => {
      const admin = await platformAdmin();
      const orgA = await createOrg(admin, 'alpha');
      const a = await addCluster(admin, orgA);
      const orgB = await createOrg(admin, 'beta');

      // Admin owns both orgs; a cluster id from A addressed through B is unknown.
      await admin.call('get', `/orgs/${orgB}/clusters/${a.cluster.id}`).expect(404);
      await admin
        .call('patch', `/orgs/${orgB}/clusters/${a.cluster.id}`, { name: 'hijack' })
        .expect(404);
      await admin.call('post', `/orgs/${orgB}/clusters/${a.cluster.id}/disable`).expect(404);
      await admin.call('delete', `/orgs/${orgB}/clusters/${a.cluster.id}`).expect(404);
      await admin
        .call('post', `/orgs/${orgB}/clusters/${a.cluster.id}/bootstrap-token`, {})
        .expect(404);

      const intact = await admin.call('get', `/orgs/${orgA}/clusters/${a.cluster.id}`).expect(200);
      expect(intact.body.name).toBe('prod-eu');
      expect(intact.body.status).toBe('PENDING');
    });
  });

  describe('enrollment', () => {
    it('trades a token for a 7-day certificate bound to the cluster, and burns the token', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const c = await addCluster(admin, orgId);

      const result = await enroll(c.bootstrapToken);

      expect(result.clusterId).toBe(c.cluster.id);
      const cert = new X509Certificate(result.certificatePem);
      expect(cert.subjectAltName).toBe(`URI:spiffe://vfm/cluster/${c.cluster.id}`);
      expect(result.caBundlePem).toContain('BEGIN CERTIFICATE');

      const cluster = (await admin.call('get', `/orgs/${orgId}/clusters/${c.cluster.id}`)).body;
      expect(cluster.status).toBe('ENROLLED');
      expect(cluster.agentVersion).toBe('0.1.0');

      await expect(enroll(c.bootstrapToken)).rejects.toThrow(/invalid or expired/);
    });

    it('lets exactly one of several concurrent enrollments win', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const c = await addCluster(admin, orgId);

      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => enroll(c.bootstrapToken)),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

      const certs = await harness.prisma.unscoped('test', () =>
        harness.prisma.agentCertificate.count({ where: { clusterId: c.cluster.id } }),
      );
      expect(certs).toBe(1);
    });

    it('gives one answer for an unknown, expired and malformed token', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const c = await addCluster(admin, orgId);
      await harness.prisma.unscoped('test', () =>
        harness.prisma.clusterBootstrapToken.updateMany({ data: { expiresAt: new Date(0) } }),
      );

      const messages: string[] = [];
      for (const token of [c.bootstrapToken, 'A'.repeat(43), '', 'not-a-token']) {
        await enroll(token).catch((e: unknown) => messages.push((e as Error).message));
      }
      expect(messages).toEqual(Array<string>(4).fill('invalid or expired bootstrap token'));
    });

    it('refuses a key that is not ECDSA P-256 without burning the token', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const c = await addCluster(admin, orgId);
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
        'sign',
        'verify',
      ]);
      const weak = await x509.Pkcs10CertificateRequestGenerator.create({
        name: 'CN=weak',
        keys,
        signingAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
      });

      await expect(
        enrollment.enroll({
          token: c.bootstrapToken,
          csrPem: weak.toString('pem'),
          clusterFingerprint: FINGERPRINT,
          agentVersion: '0.1.0',
        }),
      ).rejects.toThrow(/ECDSA P-256/);
      // The mistake is the agent's, so the operator's token must still work.
      await enroll(c.bootstrapToken);
    });

    it('refuses an agent that moved to a different cluster, until an admin resets it', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const c = await addCluster(admin, orgId);
      await enroll(c.bootstrapToken);

      const again = (
        await admin
          .call('post', `/orgs/${orgId}/clusters/${c.cluster.id}/bootstrap-token`, {})
          .expect(200)
      ).body as { bootstrapToken: string };
      await expect(enroll(again.bootstrapToken, 'some-other-kube-system-uid')).rejects.toThrow(
        /invalid or expired/,
      );

      // The refused attempt did not consume the token: the right cluster can still use it.
      await enroll(again.bootstrapToken);

      const reset = (
        await admin
          .call('post', `/orgs/${orgId}/clusters/${c.cluster.id}/bootstrap-token`, {
            resetFingerprint: true,
          })
          .expect(200)
      ).body as { bootstrapToken: string };
      await enroll(reset.bootstrapToken, 'some-other-kube-system-uid');
    });

    it('invalidates an earlier unused token when a new one is issued', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const c = await addCluster(admin, orgId);
      const second = (
        await admin
          .call('post', `/orgs/${orgId}/clusters/${c.cluster.id}/bootstrap-token`, {})
          .expect(200)
      ).body as { bootstrapToken: string };

      await expect(enroll(c.bootstrapToken)).rejects.toThrow(/invalid or expired/);
      await enroll(second.bootstrapToken);
    });
  });

  describe('client certificates', () => {
    async function enrolled() {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const c = await addCluster(admin, orgId);
      const result = await enroll(c.bootstrapToken);
      return { admin, orgId, c, result };
    }

    it('authenticates a certificate it issued', async () => {
      const { c, result } = await enrolled();
      const who = await enrollment.authenticate(der(result.certificatePem));
      expect(who.clusterId).toBe(c.cluster.id);
    });

    it('renews with the current certificate, and the old one stays valid until it expires', async () => {
      const { c, result } = await enrolled();
      const renewed = await enrollment.renew(der(result.certificatePem), await newCsr());

      expect(renewed.clusterId).toBe(c.cluster.id);
      expect(renewed.certificatePem).not.toBe(result.certificatePem);
      await enrollment.authenticate(der(renewed.certificatePem));
      await enrollment.authenticate(der(result.certificatePem));
    });

    it('refuses to renew without a valid certificate', async () => {
      await enrolled();
      await expect(enrollment.renew(Buffer.from('garbage'), await newCsr())).rejects.toThrow();
    });

    it('denies a certificate the moment its cluster is disabled, and again after re-enabling', async () => {
      const { admin, orgId, c, result } = await enrolled();
      await admin.call('post', `/orgs/${orgId}/clusters/${c.cluster.id}/disable`).expect(200);

      await expect(enrollment.authenticate(der(result.certificatePem))).rejects.toThrow(/revoked/);
      await expect(enroll(c.bootstrapToken)).rejects.toThrow(/invalid or expired/);
      await admin
        .call('post', `/orgs/${orgId}/clusters/${c.cluster.id}/bootstrap-token`, {})
        .expect(409);

      const reenabled = (
        await admin.call('post', `/orgs/${orgId}/clusters/${c.cluster.id}/enable`).expect(200)
      ).body as { bootstrapToken: string; cluster: { status: string } };
      expect(reenabled.cluster.status).toBe('PENDING');
      // The old certificate stays dead; a fresh enrollment is required.
      await expect(enrollment.authenticate(der(result.certificatePem))).rejects.toThrow(/revoked/);
      await enroll(reenabled.bootstrapToken);
    });

    it('denies a certificate once its cluster is deleted', async () => {
      const { admin, orgId, c, result } = await enrolled();
      await admin.call('delete', `/orgs/${orgId}/clusters/${c.cluster.id}`).expect(204);
      await expect(enrollment.authenticate(der(result.certificatePem))).rejects.toThrow(/revoked/);
    });

    it('rotates: every certificate is revoked and the agent must enrol again', async () => {
      const { admin, orgId, c, result } = await enrolled();
      const renewed = await enrollment.renew(der(result.certificatePem), await newCsr());

      const rotated = (
        await admin
          .call('post', `/orgs/${orgId}/clusters/${c.cluster.id}/rotate-certificate`)
          .expect(200)
      ).body as { revoked: number; bootstrapToken: string };

      expect(rotated.revoked).toBe(2);
      await expect(enrollment.authenticate(der(result.certificatePem))).rejects.toThrow(/revoked/);
      await expect(enrollment.authenticate(der(renewed.certificatePem))).rejects.toThrow(/revoked/);
      await enroll(rotated.bootstrapToken);
    });

    it('does not accept a certificate presented for a different cluster’s serial', async () => {
      const admin = await platformAdmin();
      const orgId = await createOrg(admin, 'acme');
      const one = await addCluster(admin, orgId, 'one');
      const two = await addCluster(admin, orgId, 'two');
      const a = await enroll(one.bootstrapToken);
      const b = await enroll(two.bootstrapToken, 'other-fingerprint');

      expect((await enrollment.authenticate(der(a.certificatePem))).clusterId).toBe(one.cluster.id);
      expect((await enrollment.authenticate(der(b.certificatePem))).clusterId).toBe(two.cluster.id);
    });
  });

  it('shares one CA across replicas: a second instance loads the stored CA, not a new one', async () => {
    const admin = await platformAdmin();
    const orgId = await createOrg(admin, 'acme');
    const c = await addCluster(admin, orgId);
    const result = await enroll(c.bootstrapToken);

    const second = new CaService(harness.prisma, harness.app.get(CryptoService));
    await second.ready();

    expect(await second.certificatePem()).toBe(result.caBundlePem);
    // A certificate signed by the first instance verifies on the second.
    expect((await second.verifyClientCertificate(der(result.certificatePem))).clusterId).toBe(
      c.cluster.id,
    );

    const rows = await harness.prisma.certificateAuthority.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyEncrypted.startsWith('vfm1.')).toBe(true);
    expect(rows[0]?.keyEncrypted).not.toContain('PRIVATE');
  });
});
