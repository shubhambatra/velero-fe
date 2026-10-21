import 'reflect-metadata';

import { createHash, X509Certificate } from 'node:crypto';
import tls from 'node:tls';

import { credentials, Metadata, status, type ServiceError } from '@grpc/grpc-js';
import * as x509 from '@peculiar/x509';
import type request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { generateCa, loadCa, signAgentCsr } from '../src/ca/ca';
import { CaService } from '../src/ca/ca.service';
import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { GatewayService } from '../src/gateway/gateway.service';
import {
  AgentGatewayClient,
  AgentMessage,
  type ServerMessage,
} from '../src/gateway/pb/vfm/agent/v1/gateway';
import type { EnrollResponse } from '../src/gateway/pb/vfm/agent/v1/enrollment';
import { hello } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';

/**
 * M2 day 11 over a real network: a genuine gRPC client, a real TLS handshake,
 * the real internal CA. `clusters.e2e.test.ts` proves the rules; this proves the
 * wire enforces them — which certificates a handshake lets through, which RPCs
 * demand one, and that the listener survives rotating its own identity.
 */
const PASSWORD = 'canopy-vellum-ratchet-82';
const FINGERPRINT = 'f3a1c2d4-kube-system-uid-0001';

interface Keypair {
  csrPem: string;
  privateKeyPem: string;
}

async function keypair(): Promise<Keypair> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=agent',
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${(pkcs8.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { csrPem: csr.toString('pem'), privateKeyPem: pem };
}

/** The gRPC error a call rejects with; fails the test if it succeeds. */
async function errorOf(call: Promise<unknown>): Promise<ServiceError> {
  try {
    await call;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

describe('agent gateway (e2e, real mTLS)', () => {
  let harness: TestApp;
  let sessions: SessionService;
  let gateway: GatewayService;
  let caPem: string;
  const clients: AgentGatewayClient[] = [];

  beforeAll(async () => {
    harness = await createTestApp({ gateway: true });
    sessions = harness.app.get(SessionService);
    gateway = harness.app.get(GatewayService);
    caPem = await harness.app.get(CaService).certificatePem();
  }, 60_000);

  afterAll(async () => {
    for (const client of clients) {
      client.close();
    }
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  const api = (): request.Agent => harness.api();

  async function actAs(userId: string) {
    const created = await sessions.create({ userId, ip: '127.0.0.1', userAgent: 'vitest' });
    const cookie = `${SessionService.COOKIE}=${created.id}; ${SessionService.CSRF_COOKIE}=${created.csrfToken}`;
    return (method: 'get' | 'post' | 'delete', path: string, body?: object) => {
      const req = api()
        [method](`/api/v1${path}`)
        .set('Cookie', cookie)
        .set(CSRF_HEADER, created.csrfToken);
      return body === undefined ? req : req.send(body);
    };
  }

  async function newCluster(name = 'prod-eu') {
    const setupToken = 'setup-' + Math.random().toString(36).slice(2);
    await harness.redis.connection.set(
      'vfm:setup:token',
      createHash('sha256').update(setupToken, 'utf8').digest('hex'),
      'EX',
      3_600,
    );
    const user = await api()
      .post('/api/v1/auth/setup')
      .send({ token: setupToken, email: 'root@vfm.local', password: PASSWORD })
      .expect(201);
    const call = await actAs(user.body.user.id as string);
    const org = await call('post', '/orgs', { name: 'Acme', slug: 'acme' }).expect(201);
    const orgId = org.body.id as string;
    await call('post', '/me/active-org', { orgId }).expect(204);
    const created = await call('post', `/orgs/${orgId}/clusters`, { name }).expect(201);
    return {
      call,
      orgId,
      clusterId: created.body.cluster.id as string,
      token: created.body.bootstrapToken as string,
    };
  }

  function client(options: {
    trust?: string;
    cert?: { chain: string; key: string };
  }): AgentGatewayClient {
    const creds = credentials.createSsl(
      Buffer.from(options.trust ?? caPem),
      options.cert === undefined ? null : Buffer.from(options.cert.key),
      options.cert === undefined ? null : Buffer.from(options.cert.chain),
    );
    const c = new AgentGatewayClient(`127.0.0.1:${gateway.boundPort.toString()}`, creds, {
      'grpc.ssl_target_name_override': 'localhost',
    });
    clients.push(c);
    return c;
  }

  const enroll = (
    c: AgentGatewayClient,
    token: string,
    csrPem: string,
    fingerprint = FINGERPRINT,
  ): Promise<EnrollResponse> =>
    new Promise((resolve, reject) => {
      c.enroll(
        {
          bootstrapToken: token,
          csrPem: Buffer.from(csrPem),
          clusterFingerprint: fingerprint,
          agentVersion: '0.1.0',
          protocolVersion: 1,
        },
        (error, response) => {
          if (error !== null) {
            reject(error);
          } else {
            resolve(response);
          }
        },
      );
    });

  const renew = (c: AgentGatewayClient, csrPem: string) =>
    new Promise<{ certificatePem: Uint8Array }>((resolve, reject) => {
      c.renewCertificate({ csrPem: Buffer.from(csrPem) }, (error, response) => {
        if (error !== null) {
          reject(error);
        } else {
          resolve(response);
        }
      });
    });

  /** Opens a stream with a valid Hello; resolves 'acked' on HelloAck or with the refusal. */
  const connectOutcome = (c: AgentGatewayClient): Promise<ServiceError | 'acked'> =>
    new Promise((resolve) => {
      const stream = c.connect(new Metadata());
      stream.on('error', (error) => {
        resolve(error as ServiceError);
      });
      stream.on('data', (message: ServerMessage) => {
        if (message.helloAck !== undefined) {
          stream.cancel();
          resolve('acked');
        }
      });
      stream.write(AgentMessage.fromPartial(hello()));
    });

  const codeOf = (outcome: ServiceError | 'acked'): number | string =>
    outcome === 'acked' ? outcome : outcome.code;

  async function enrolledAgent() {
    const cluster = await newCluster();
    const keys = await keypair();
    const response = await enroll(client({}), cluster.token, keys.csrPem);
    return {
      ...cluster,
      keys,
      response,
      cert: { chain: Buffer.from(response.certificatePem).toString(), key: keys.privateKeyPem },
    };
  }

  it('enrolls over a real TLS handshake and gets a certificate for the right cluster', async () => {
    const cluster = await newCluster();
    const keys = await keypair();

    const response = await enroll(client({}), cluster.token, keys.csrPem);

    expect(response.clusterId).toBe(cluster.clusterId);
    const cert = new X509Certificate(Buffer.from(response.certificatePem));
    expect(cert.subjectAltName).toBe(`URI:spiffe://vfm/cluster/${cluster.clusterId}`);
    expect(Buffer.from(response.caBundlePem).toString()).toBe(caPem);
    expect(response.notAfter).toBeInstanceOf(Date);
  });

  it('refuses a replayed token with the same answer as any bad token', async () => {
    const cluster = await newCluster();
    const keys = await keypair();
    await enroll(client({}), cluster.token, keys.csrPem);

    const replay = await errorOf(enroll(client({}), cluster.token, keys.csrPem));
    const garbage = await errorOf(enroll(client({}), 'nope', keys.csrPem));
    expect(replay.code).toBe(status.UNAUTHENTICATED);
    expect(garbage.code).toBe(status.UNAUTHENTICATED);
    expect(replay.details).toBe(garbage.details);
  });

  it('renews over mTLS with the current certificate', async () => {
    const agent = await enrolledAgent();
    const next = await keypair();

    const renewed = await renew(client({ cert: agent.cert }), next.csrPem);

    expect(new X509Certificate(Buffer.from(renewed.certificatePem)).serialNumber).not.toBe(
      new X509Certificate(Buffer.from(agent.response.certificatePem)).serialNumber,
    );
  });

  it('demands a certificate for Renew and Connect, but not for Enroll', async () => {
    const agent = await enrolledAgent();
    const anonymous = client({});

    expect((await errorOf(renew(anonymous, agent.keys.csrPem))).code).toBe(status.UNAUTHENTICATED);
    expect(codeOf(await connectOutcome(anonymous))).toBe(status.UNAUTHENTICATED);
  });

  it('lets a valid certificate open a stream and be acknowledged', async () => {
    const agent = await enrolledAgent();
    expect(await connectOutcome(client({ cert: agent.cert }))).toBe('acked');
  });

  it('does not authenticate a certificate signed by another CA, even with the right identity', async () => {
    const agent = await enrolledAgent();
    const other = await generateCa();
    const forgedCa = await loadCa(other.certificatePem, other.privateKeyPkcs8);
    const keys = await keypair();
    const forged = await signAgentCsr(forgedCa, keys.csrPem, agent.clusterId);

    const attacker = client({ cert: { chain: forged.certificatePem, key: keys.privateKeyPem } });
    expect(codeOf(await connectOutcome(attacker))).toBe(status.UNAUTHENTICATED);
    expect((await errorOf(renew(attacker, keys.csrPem))).code).toBe(status.UNAUTHENTICATED);
  });

  it('stops authenticating a certificate the moment its cluster is disabled', async () => {
    const agent = await enrolledAgent();
    const c = client({ cert: agent.cert });
    expect(await connectOutcome(c)).toBe('acked');

    await agent
      .call('post', `/orgs/${agent.orgId}/clusters/${agent.clusterId}/disable`)
      .expect(200);

    expect(codeOf(await connectOutcome(client({ cert: agent.cert })))).toBe(status.UNAUTHENTICATED);
  });

  it('lets an agent pin the control plane: a client that trusts a different CA cannot connect', async () => {
    const cluster = await newCluster();
    const keys = await keypair();
    const other = await generateCa();

    const error = await errorOf(
      enroll(client({ trust: other.certificatePem }), cluster.token, keys.csrPem),
    );
    expect(error.code).toBe(status.UNAVAILABLE);

    // The failed handshake never reached the application, so the token is intact.
    await enroll(client({}), cluster.token, keys.csrPem);
  });

  it('enforces the 4 MB message limit', async () => {
    const huge = 'A'.repeat(5 * 1024 * 1024);
    const error = await errorOf(enroll(client({}), huge, (await keypair()).csrPem));
    expect(error.code).toBe(status.RESOURCE_EXHAUSTED);
  });

  it('rejects oversized fields below the message limit', async () => {
    const error = await errorOf(enroll(client({}), 'A'.repeat(1_000), (await keypair()).csrPem));
    expect(error.code).toBe(status.INVALID_ARGUMENT);
  });

  it('swaps its own TLS certificate without dropping the listener', async () => {
    const serial = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = tls.connect(
          {
            host: '127.0.0.1',
            port: gateway.boundPort,
            servername: 'localhost',
            ca: caPem,
            ALPNProtocols: ['h2'],
          },
          () => {
            const value = socket.getPeerCertificate().serialNumber;
            socket.end();
            resolve(value);
          },
        );
        socket.on('error', reject);
      });

    const before = await serial();
    await gateway.rotateServerCertificate();
    const after = await serial();
    expect(after).not.toBe(before);

    // And an agent can still enrol through the rotated listener.
    const cluster = await newCluster();
    await enroll(client({}), cluster.token, (await keypair()).csrPem);
  });
});
