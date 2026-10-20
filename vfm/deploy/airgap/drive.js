'use strict';
// Drives a running control plane the way an operator and an agent would, using only what is inside the
// control-plane image: first-run setup, MFA enrolment, an organization, a cluster, the agent's enrol
// + mTLS connect + Hello, and then reads the cluster back as CONNECTED.
//
// Run INSIDE the isolated network by verify-airgap.sh:
//   docker run --rm --network NET -e SETUP_TOKEN=... IMAGE node /drive.js http://cp:3000 cp:8443
require('/app/node_modules/reflect-metadata');
const crypto = require('node:crypto');
const x509 = require('/app/node_modules/@peculiar/x509');
const { credentials, Metadata } = require('/app/node_modules/@grpc/grpc-js');
const { AgentGatewayClient, AgentMessage } = require('/app/dist/gateway/pb/vfm/agent/v1/gateway');

const [, , BASE, GATEWAY] = process.argv;
const API = `${BASE}/api/v1`;
const EMAIL = 'admin@airgap.test';
const PASSWORD = 'airgap-Correct-Horse-9';
let passed = 0;
const ok = (what) => {
  passed += 1;
  console.log(`  PASS  ${what}`);
};
const fail = (what, extra) => {
  console.error(`  FAIL  ${what}${extra ? `: ${extra}` : ''}`);
  process.exit(1);
};
const check = (cond, what, extra) => (cond ? ok(what) : fail(what, extra));

const jar = {};
async function call(method, path, body, expect) {
  const headers = { 'content-type': 'application/json' };
  if (Object.keys(jar).length)
    headers.cookie = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  if (jar.vfm_csrf) headers['x-csrf-token'] = jar.vfm_csrf;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (expect !== undefined && res.status !== expect)
    fail(`${method} ${path} -> ${res.status}`, `wanted ${expect}: ${text.slice(0, 200)}`);
  return { status: res.status, json, text, headers: res.headers };
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret, so no library is needed.
function totp(secretBase32, stepOffset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + stepOffset));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 0xf;
  return String(
    (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000,
  ).padStart(6, '0');
}

async function main() {
  console.log(`driving ${BASE} (gateway ${GATEWAY})`);

  // --- the web UI is served by the control plane itself, under its own CSP -----------------------------
  const page = await fetch(`${BASE}/`);
  const html = await page.text();
  check(page.status === 200 && html.includes('id="root"'), 'GET / serves the built web UI');
  check(
    !/(https?:)?\/\/(fonts\.|cdn\.|unpkg|cdnjs|jsdelivr)/i.test(html),
    'the UI page references no CDN or external font host',
  );
  const csp = page.headers.get('content-security-policy') ?? '';
  check(
    (csp.includes("default-src 'self'") && !csp.includes("'unsafe-inline'")) ||
      csp.includes("script-src 'self'"),
    'the UI is served with a strict Content-Security-Policy',
    csp,
  );
  const deep = await fetch(`${BASE}/clusters/abc/backups`);
  check(
    deep.status === 200 && (await deep.text()).includes('id="root"'),
    'a client-side route falls back to the app (reload-safe)',
  );
  const missing = await fetch(`${API}/does-not-exist`);
  check(
    missing.status === 404 && !(await missing.text()).includes('id="root"'),
    'an unknown API path is a 404, not the app',
  );
  const metricsOnPublic = await fetch(`${BASE}/metrics`);
  check(
    !(await metricsOnPublic.text()).includes('vfm_'),
    'metrics are not served on the public port',
  );

  // --- first run -------------------------------------------------------------------------------------
  const status = await call('GET', '/auth/setup', undefined, 200);
  check(JSON.stringify(status.json).includes('true'), 'setup is open on a fresh install');
  await call(
    'POST',
    '/auth/setup',
    { token: process.env.SETUP_TOKEN, email: EMAIL, password: PASSWORD },
    201,
  );
  ok('the first administrator is created with the one-time setup token');
  const again = await call('POST', '/auth/setup', {
    token: process.env.SETUP_TOKEN,
    email: 'x@y.test',
    password: PASSWORD,
  });
  check(
    again.status === 401 || again.status === 403 || again.status === 409,
    'the setup token cannot be used twice',
    String(again.status),
  );

  const enrol = await call('POST', '/auth/mfa/enrol', undefined, 200);
  await call('POST', '/auth/mfa/enrol/confirm', { code: totp(enrol.json.secret) }, 200);
  ok('the administrator enrols a second factor (required for administrators)');

  const me = await call('GET', '/auth/me', undefined, 200);
  check(
    me.json && (me.json.user?.email ?? me.json.email) === EMAIL,
    'GET /auth/me knows the signed-in user',
  );

  const org = await call('POST', '/orgs', { name: 'Air Gap', slug: 'airgap' }, 201);
  const orgId = org.json.id;
  await call('POST', '/me/active-org', { orgId }, 204);
  ok('an organization is created');

  // --- an agent, from inside the isolated network ------------------------------------------------------
  const created = await call('POST', `/orgs/${orgId}/clusters`, { name: 'edge-1' }, 201);
  const clusterId = created.json.cluster.id;
  const ca = created.json.installCommand.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
  )?.[0];
  check(
    Boolean(ca) && /^[A-Za-z0-9_-]{43}$/.test(created.json.bootstrapToken),
    'Add cluster returns a single-use token and the CA bundle',
  );

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

  const FINGERPRINT = 'airgap-kube-system-uid-0001';
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
  check(enrolled.clusterId === clusterId, 'the agent enrols over TLS against the internal CA');
  const reuse = await new Promise((resolve) =>
    anon.enroll(
      {
        bootstrapToken: created.json.bootstrapToken,
        csrPem: Buffer.from(csr.toString('pem')),
        clusterFingerprint: FINGERPRINT,
        agentVersion: '0.1.0',
        protocolVersion: 1,
      },
      (e) => resolve(e),
    ),
  );
  check(Boolean(reuse), 'a bootstrap token cannot enrol twice');

  const mtls = new AgentGatewayClient(
    GATEWAY,
    credentials.createSsl(
      Buffer.from(ca),
      Buffer.from(keyPem),
      Buffer.from(enrolled.certificatePem),
    ),
  );
  const stream = mtls.connect(new Metadata());
  const inbox = [];
  stream.on('data', (m) => inbox.push(m));
  stream.on('error', (e) => console.error('stream error', e.message));
  stream.write(
    AgentMessage.fromPartial({
      messageId: 'hello-1',
      hello: {
        protocolVersion: 1,
        agentVersion: '0.1.0',
        chartVersion: '0.1.0',
        imageTag: 'airgap',
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
    }),
  );
  const until = async (what, fn, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    fail(what, 'timed out');
  };
  const ack = await until('HelloAck', () => inbox.find((m) => m.helloAck));
  check(
    ack.helloAck.config.maxMessageBytes === 4 * 1024 * 1024,
    'the control plane acknowledges Hello with its limits',
  );
  stream.write(AgentMessage.fromPartial({ messageId: 'hb-1', heartbeat: {} }));

  const connected = await until('cluster CONNECTED', async () => {
    const r = await call('GET', `/orgs/${orgId}/clusters/${clusterId}`);
    return r.json?.status === 'CONNECTED' || r.json?.cluster?.status === 'CONNECTED'
      ? r.json
      : undefined;
  });
  ok('the cluster page reads CONNECTED, with the Velero version the agent reported');
  check(JSON.stringify(connected).includes('v1.18.4'), 'the Velero version from Hello is shown');

  const fleet = await call('GET', `/orgs/${orgId}/fleet`, undefined, 200);
  check(JSON.stringify(fleet.json).includes('edge-1'), 'the fleet overview lists the cluster');

  // A cluster that is disabled has its stream closed.
  stream.cancel();
  mtls.close();
  anon.close();
  console.log(`\n${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
