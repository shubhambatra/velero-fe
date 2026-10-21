#!/usr/bin/env node
// Enrols SIMULATED clusters next to the real one in the e2e control plane, for looking at the multi-cluster UI.
// They are agents from agent/cmd/loadtest (generated inventories, no Velero behind them) and are named `sim-*`.
//
//   node e2e/sim-clusters.mjs            writes $VFM_E2E_STATE/sim-fixture.json and creates the clusters
//   loadtest --fixture $VFM_E2E_STATE/sim-fixture.json --agents 0 --users 0 --commands-per-sec 0 --duration 4h
import fs from 'node:fs';
import path from 'node:path';

import { Api, readJson, sh, sleep, totp } from './lib.mjs';

const BASE = process.env.VFM_API ?? 'http://127.0.0.1:3200';
const STATE = process.env.VFM_E2E_STATE ?? '/tmp/vfm-e2e-state';
const EMAIL = 'admin@e2e.test';
const PASSWORD = 'e2e-Correct-Horse-Battery-9';
const SIMS = [
  { name: 'sim-eu-prod', labels: { env: 'prod', region: 'eu' } },
  { name: 'sim-us-prod', labels: { env: 'prod', region: 'us' } },
  { name: 'sim-eu-staging', labels: { env: 'staging', region: 'eu' } },
  { name: 'sim-dr', labels: { env: 'dr', region: 'us' } },
];

const api = new Api(BASE, PASSWORD);
const admin = readJson(path.join(STATE, 'admin.json'));
await api.call('POST', '/auth/login', { email: EMAIL, password: PASSWORD }, 200);
let ok = false;
for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
  for (const step of [0, 1]) {
    const res = await api.raw('POST', '/auth/mfa/challenge', {
      code: totp(admin.totpSecret, step),
    });
    if (res.status === 200) {
      ok = true;
      break;
    }
  }
  if (!ok) await sleep(31_000);
}
if (!ok) throw new Error('MFA challenge failed');
const orgs = (await api.call('GET', '/me/orgs', undefined, 200)).json.orgs;
const org = orgs.find((o) => o.slug === 'e2e');
await api.call('POST', '/me/active-org', { orgId: org.id }, 204);

const existing = (await api.call('GET', `/orgs/${org.id}/clusters`, undefined, 200)).json.clusters;
const clusters = [];
let ca = '';
for (const s of SIMS) {
  const old = existing.find((c) => c.name === s.name);
  if (old) await api.call('DELETE', `/orgs/${org.id}/clusters/${old.id}`, undefined, [200, 204]);
  const made = await api.call('POST', `/orgs/${org.id}/clusters`, s, 201);
  ca = made.json.installCommand.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
  )[0];
  clusters.push({
    id: made.json.cluster.id,
    name: s.name,
    bootstrapToken: made.json.bootstrapToken,
  });
}
const ip = sh('docker', [
  'inspect',
  '-f',
  '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
  'vfm-e2e-cp1',
]).split(' ')[0];
const fixture = {
  apiBase: `${BASE}/api/v1`,
  gateway: `${ip}:8443`,
  gatewayServerName: 'vfm-cp',
  caPem: ca + '\n',
  orgId: org.id,
  adminCookie: Object.entries(api.jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; '),
  adminCsrf: api.jar.vfm_csrf ?? '',
  clusters,
  users: [],
};
fs.writeFileSync(path.join(STATE, 'sim-fixture.json'), JSON.stringify(fixture));
console.log(
  `${clusters.length} simulated clusters created; fixture at ${path.join(STATE, 'sim-fixture.json')}`,
);
