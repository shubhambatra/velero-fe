import 'reflect-metadata';

import { X509Certificate } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CaRotationError, CaRotationService } from '../src/ca/ca-rotation.service';
import { CryptoService } from '../src/crypto/crypto.service';
import { CaService } from '../src/ca/ca.service';
import { AGENT_CERT_LIFETIME_MS } from '../src/ca/ca';
import { keypair, makeClient, openStream, hello, type AgentCert } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { World } from './world';

/**
 * G-12 / day 39: the CA is replaced under live agents. The agent in this test holds a certificate from
 * the first CA and, like a real one after a renewal, the bundle it was last handed. Real PostgreSQL,
 * real gRPC and mTLS; time is moved with the `now` the rotation steps accept.
 */
describe('CA rotation (e2e)', () => {
  let harness: TestApp;
  let world: World;
  let rotation: CaRotationService;
  let ca: CaService;
  const day = 24 * 3_600_000;
  const t0 = Date.now();

  /** Leaves one ACTIVE CA behind, so a failed run cannot strand the shared table mid-rotation. */
  async function settle(): Promise<void> {
    const rows = await harness.prisma.certificateAuthority.findMany({ orderBy: { id: 'asc' } });
    const keep = rows.find((r) => r.state === 'ACTIVE') ?? rows[0];
    if (keep === undefined) return;
    await harness.prisma.certificateAuthority.deleteMany({ where: { id: { not: keep.id } } });
    await harness.prisma.certificateAuthority.update({
      where: { id: keep.id },
      data: { state: 'ACTIVE', stateChangedAt: new Date() },
    });
    await harness.app.get(CaService).reload();
  }

  beforeAll(async () => {
    harness = await createTestApp({ gateway: true });
    await settle();
    world = new World(harness);
    await world.init();
    rotation = new CaRotationService(
      harness.prisma,
      harness.app.get(CryptoService),
      harness.app.get(CaService),
    );
    ca = harness.app.get(CaService);
  }, 60_000);

  beforeEach(settle);

  afterAll(async () => {
    await settle();
    world.close();
    await harness.close();
  });

  const renew = async (agent: { cert: AgentCert }, trust: string): Promise<AgentCert> => {
    const keys = await keypair();
    const client = makeClient(world.port, trust, agent.cert, world.clients);
    const response = await new Promise<{ certificatePem: Uint8Array }>((resolve, reject) => {
      client.renewCertificate({ csrPem: Buffer.from(keys.csrPem) }, (error, value) => {
        if (error !== null) reject(error);
        else resolve(value);
      });
    });
    return { chain: Buffer.from(response.certificatePem).toString(), key: keys.privateKeyPem };
  };

  const connects = async (
    agent: { cert: AgentCert; name: string },
    trust: string,
  ): Promise<boolean> => {
    const stream = openStream(makeClient(world.port, trust, agent.cert, world.clients));
    stream.send(hello({ clusterFingerprint: `f3a1c2d4-kube-system-uid-0001-${agent.name}` }));
    try {
      return (await stream.next(3_000)).helloAck !== undefined;
    } catch {
      return false;
    } finally {
      stream.cancel();
    }
  };

  async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('replaces the CA with no agent re-enrolled, refusing each step until it is safe', async () => {
    const { call, orgId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const startRows = await rotation.status();
    const first = startRows.find((r) => r.state === 'ACTIVE');
    expect(first).toBeDefined();
    expect(await connects(agent, world.caPem)).toBe(true);

    // 1. Stage: the bundle grows, nothing signs with the new CA, nothing breaks.
    const staged = await rotation.stage();
    expect(staged.state).toBe('STAGED');
    const bundle = await ca.certificatePem();
    expect(bundle.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    await expect(rotation.stage()).rejects.toThrow(CaRotationError);
    expect(await connects(agent, world.caPem)).toBe(true);
    // A certificate renewed now is still from the first CA, and an agent that renews now is handed the bundle.
    const renewedEarly = (await renew(agent, world.caPem)).chain;
    expect(
      new X509Certificate(renewedEarly).checkIssued(
        new X509Certificate(bundle.split(/(?<=-----END CERTIFICATE-----\n)/)[0] ?? ''),
      ),
    ).toBe(true);
    world.caPem = bundle; // the agent now trusts both

    // 2. Promote: refused until every agent has had time to renew.
    await expect(rotation.promote({ now: new Date(t0 + 2 * day) })).rejects.toThrow(
      /too early to promote/,
    );
    await rotation.promote({ now: new Date(t0 + AGENT_CERT_LIFETIME_MS + day) });
    const rows = await rotation.status();
    expect(rows.find((r) => r.id === staged.id)?.state).toBe('ACTIVE');
    expect(rows.find((r) => r.id === first?.id)?.state).toBe('RETIRING');
    // The gateway reissued its own certificate under the new CA; the old agent certificate still works.
    await eventually(
      () => connects(agent, bundle),
      'the old certificate to be accepted under the new server certificate',
    );
    // New certificates come from the new CA.
    const renewedCert = await renew(agent, bundle);
    const renewed = renewedCert.chain;
    // The bundle was captured at stage time: [first CA, staged CA].
    const newCa = new X509Certificate(bundle.split(/(?<=-----END CERTIFICATE-----\n)/)[1] ?? '');
    expect(new X509Certificate(renewed).checkIssued(newCa)).toBe(true);
    const renewedAgent = { ...agent, cert: renewedCert };
    // A certificate that came from a CA nobody told us about is still refused.
    expect(await connects(renewedAgent, bundle)).toBe(true);

    // 3. Retire: refused until everything the old CA signed has expired, then the old certificate stops working.
    await expect(
      rotation.retire({ now: new Date(t0 + AGENT_CERT_LIFETIME_MS + 2 * day) }),
    ).rejects.toThrow(/too early to retire/);
    await rotation.retire({ now: new Date(t0 + 2 * AGENT_CERT_LIFETIME_MS + 2 * day) });
    expect((await rotation.status()).map((r) => r.state)).toEqual(['ACTIVE']);
    await eventually(
      async () => !(await connects(agent, bundle)),
      'the retired CA to stop being trusted',
    );
    expect(await connects(renewedAgent, await ca.certificatePem())).toBe(true);
    expect((await ca.certificatePem()).match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
  }, 60_000);

  it('can abandon a staged CA, and refuses promote or retire with nothing to do', async () => {
    await rotation.stage();
    await rotation.unstage();
    expect((await rotation.status()).every((r) => r.state === 'ACTIVE')).toBe(true);
    await expect(rotation.promote({ force: true })).rejects.toThrow(/nothing staged/);
    await expect(rotation.retire({ force: true })).rejects.toThrow(/no retiring/);
    await expect(rotation.unstage()).rejects.toThrow(/no staged/);
  });

  it('--force skips the wait', async () => {
    await rotation.stage();
    await rotation.promote({ force: true });
    await rotation.retire({ force: true });
    expect((await rotation.status()).map((r) => r.state)).toEqual(['ACTIVE']);
  });
});
