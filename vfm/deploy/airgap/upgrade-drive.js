'use strict';
// seed | probe | verify, for verify-upgrade.sh. Runs inside a control-plane image; state lives in /state.
require('/app/node_modules/reflect-metadata');
const crypto = require('node:crypto');
const fs = require('node:fs');
const x509 = require('/app/node_modules/@peculiar/x509');
const { credentials, Metadata } = require('/app/node_modules/@grpc/grpc-js');
const { AgentGatewayClient, AgentMessage } = require('/app/dist/gateway/pb/vfm/agent/v1/gateway');
const { ok, fail, check, client, totp, until, passed } = require('./lib');

const [, , MODE, BASE, GATEWAY] = process.argv;
const STATE = '/state/state.json';
const EMAIL = 'admin@upgrade.test';
const PASSWORD = 'upgrade-Correct-Horse-9';
const FINGERPRINT = 'upgrade-kube-system-uid-0001';
const { call } = client(BASE);

const helloMessage = () =>
  AgentMessage.fromPartial({
    messageId: 'hello-1',
    hello: {
      protocolVersion: 1,
      agentVersion: '0.1.0',
      chartVersion: '0.1.0',
      imageTag: 'upgrade',
      kubernetesVersion: 'v1.31.0',
      clusterFingerprint: FINGERPRINT,
      velero: {
        serverVersion: 'v1.18.4',
        plugins: [{ name: 'velero.io/aws', kind: 'ObjectStore' }],
      },
      capabilities: [],
      policy: {
        allowRestore: true,
        restoreDeniedNamespaces: ['kube-system'],
        allowBslWrite: true,
        allowLogStreaming: true,
        logStreamDeniedNamespaces: [],
        readOnly: false,
      },
    },
  });

async function seed() {
  console.log(`seeding ${BASE}`);
  await call(
    'POST',
    '/auth/setup',
    { token: process.env.SETUP_TOKEN, email: EMAIL, password: PASSWORD },
    201,
  );
  const enrol = await call('POST', '/auth/mfa/enrol', undefined, 200);
  await call('POST', '/auth/mfa/enrol/confirm', { code: totp(enrol.json.secret) }, 200);
  const org = await call('POST', '/orgs', { name: 'Upgrade Co', slug: 'upgrade' }, 201);
  await call('POST', '/me/active-org', { orgId: org.json.id }, 204);
  const created = await call('POST', `/orgs/${org.json.id}/clusters`, { name: 'edge-1' }, 201);
  const ca = created.json.installCommand.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
  )[0];
  ok('the previous release: first-run setup, MFA, an organization and a cluster');

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
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END PRIVATE KEY-----\n`;
  const anon = new AgentGatewayClient(GATEWAY, credentials.createSsl(Buffer.from(ca)));
  const enrolled = await new Promise((resolve, reject) =>
    anon.enroll(
      {
        bootstrapToken: created.json.bootstrapToken,
        csrPem: Buffer.from(csr.toString('pem')),
        clusterFingerprint: FINGERPRINT,
        agentVersion: '0.1.0',
        protocolVersion: 1,
      },
      (e, r) => (e ? reject(e) : resolve(r)),
    ),
  );
  await connectAgent(
    ca,
    keyPem,
    Buffer.from(enrolled.certificatePem).toString(),
    'the previous release',
  );
  await until('cluster CONNECTED', async () => {
    const r = await call('GET', `/orgs/${org.json.id}/clusters/${created.json.cluster.id}`);
    return (r.json?.status ?? r.json?.cluster?.status) === 'CONNECTED';
  });
  ok('an agent enrolled with the previous release is CONNECTED to it');
  fs.writeFileSync(
    STATE,
    JSON.stringify({
      totpSecret: enrol.json.secret,
      orgId: org.json.id,
      clusterId: created.json.cluster.id,
      ca,
      keyPem,
      certPem: Buffer.from(enrolled.certificatePem).toString(),
    }),
  );
  anon.close();
}

async function connectAgent(ca, keyPem, certPem, who) {
  const mtls = new AgentGatewayClient(
    GATEWAY,
    credentials.createSsl(Buffer.from(ca), Buffer.from(keyPem), Buffer.from(certPem)),
  );
  const stream = mtls.connect(new Metadata());
  const inbox = [];
  stream.on('data', (m) => inbox.push(m));
  stream.on('error', () => undefined);
  stream.write(helloMessage());
  const ack = await until(`HelloAck from ${who}`, () => inbox.find((m) => m.helloAck));
  check(Boolean(ack.helloAck), `${who} accepts the agent's Hello`);
  stream.write(AgentMessage.fromPartial({ messageId: 'hb-1', heartbeat: {} }));
  return { stream, mtls };
}

// Requests on fresh connections (no keep-alive), so each one resolves the name again and lands wherever the
// rollout currently routes it, until /state/stop appears.
async function probe() {
  let total = 0;
  const failures = [];
  const paths = ['/readyz', '/api/v1/auth/setup', '/healthz'];
  while (!fs.existsSync('/state/stop')) {
    const path = paths[total % paths.length];
    total += 1;
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status !== 200)
        failures.push({ path, status: res.status, at: new Date().toISOString() });
      await res.arrayBuffer();
    } catch (e) {
      failures.push({
        path,
        error: String(e.cause?.code ?? e.message),
        at: new Date().toISOString(),
      });
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  fs.writeFileSync('/state/probe.json', JSON.stringify({ total, failures }));
  console.log(`probe: ${total} requests, ${failures.length} failed`);
}

async function verify() {
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  console.log(`verifying ${BASE} after the upgrade`);
  const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD }, 200);
  check(
    JSON.stringify(login.json).toLowerCase().includes('mfa') || login.status === 200,
    'the password set under the previous release still signs in',
  );
  await call('POST', '/auth/mfa/challenge', { code: totp(s.totpSecret, 1) }, 200);
  ok('the second factor enrolled under the previous release still verifies');
  const me = await call('GET', '/auth/me', undefined, 200);
  check(JSON.stringify(me.json).includes(EMAIL), 'the user and session work');
  const cluster = await call('GET', `/orgs/${s.orgId}/clusters/${s.clusterId}`, undefined, 200);
  check(
    JSON.stringify(cluster.json).includes('edge-1'),
    'the organization and cluster created before the upgrade are intact',
  );
  const audit = await call('GET', `/orgs/${s.orgId}/audit?limit=50`, undefined, 200);
  check(
    JSON.stringify(audit.json).includes('cluster'),
    'the audit log written before the upgrade is intact',
  );
  const { stream, mtls } = await connectAgent(s.ca, s.keyPem, s.certPem, 'the new release');
  await until('cluster CONNECTED on the new release', async () => {
    const r = await call('GET', `/orgs/${s.orgId}/clusters/${s.clusterId}`);
    return (r.json?.status ?? r.json?.cluster?.status) === 'CONNECTED';
  });
  ok(
    'the agent enrolled under the previous release reconnects to the new one with its old certificate',
  );
  stream.cancel();
  mtls.close();
  console.log(`\n${passed()} checks passed`);
}

({ seed, probe, verify })[MODE]?.().catch((e) => {
  console.error(e);
  process.exit(1);
}) ?? fail(`unknown mode ${MODE}`);
