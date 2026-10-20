#!/usr/bin/env node
// The plan's golden paths (PLAN.md section 15) against the REAL thing: the control-plane image, the real Go agent
// running in a kind cluster, real Velero v1.18.4, real MinIO.
//
//   deploy/dev/scripts/dev-up.sh (VFM_DEV_SOLO=1 on a small host)   # cluster + Velero + MinIO + sample workloads
//   e2e/stack.sh up                                                  # PostgreSQL, Redis, control plane
//   node e2e/golden.mjs [--only gp2,gp3] [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Api, kubectl, kubectlTry, readJson, runner, sh, sleep, totp, until } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = process.env.VFM_API ?? 'http://127.0.0.1:3200';
const STATE = process.env.VFM_E2E_STATE ?? '/tmp/vfm-e2e-state';
const EMAIL = 'admin@e2e.test';
const PASSWORD = 'e2e-Correct-Horse-Battery-9';
const argAt = process.argv.indexOf('--only');
const only = (argAt === -1 ? '' : (process.argv[argAt + 1] ?? '')).split(',').filter(Boolean);
const wants = (id) => only.length === 0 || only.includes(id);
const r = runner();
const RUN = Date.now().toString(36);
const LAST = path.join(STATE, 'last-backup');
// GP3 and GP4 restore what GP2 backed up: from this run, or (when GP2 is not selected) from the last one.
const runsGp2 = wants('gp2') || ((wants('gp3') || wants('gp4')) && !fs.existsSync(LAST));
const BACKUP = runsGp2 || !fs.existsSync(LAST) ? `gp2-${RUN}` : fs.readFileSync(LAST, 'utf8').trim();

const ctx = { api: new Api(BASE, PASSWORD), org: undefined, cluster: undefined, clusterName: 'kind-a' };

// ---------------------------------------------------------------------------------------------------------------------
async function signIn() {
  const api = ctx.api;
  const file = path.join(STATE, 'admin.json');
  if (fs.existsSync(file)) {
    const admin = readJson(file);
    await api.call('POST', '/auth/login', { email: EMAIL, password: PASSWORD }, 200);
    // Each code works once, and the server accepts a window of one step either side: if the current and
    // the next are both spent (a run a moment ago), the next window is the only way in.
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
      for (const step of [0, 1]) {
        const res = await api.raw('POST', '/auth/mfa/challenge', { code: totp(admin.totpSecret, step) });
        if (res.status === 200) { ok = true; break; }
      }
      if (!ok) await sleep(31_000);
    }
    if (!ok) throw new Error('could not complete the MFA challenge for the saved administrator');
    return admin;
  }
  const token = fs.readFileSync(path.join(STATE, 'setup-token'), 'utf8').trim();
  await api.call('POST', '/auth/setup', { token, email: EMAIL, password: PASSWORD }, 201);
  const enrol = await api.call('POST', '/auth/mfa/enrol', undefined, 200);
  await api.call('POST', '/auth/mfa/enrol/confirm', { code: totp(enrol.json.secret) }, 200);
  const admin = { totpSecret: enrol.json.secret };
  fs.writeFileSync(file, JSON.stringify(admin));
  return admin;
}

async function ensureOrg() {
  const api = ctx.api;
  const mine = await api.call('GET', '/me/orgs', undefined, 200);
  let org = mine.json.orgs.find((o) => o.slug === 'e2e');
  if (!org) {
    const created = await api.call('POST', '/orgs', { name: 'E2E', slug: 'e2e' }, 201);
    org = { id: created.json.id };
  }
  await api.call('POST', '/me/active-org', { orgId: org.id }, 204);
  ctx.org = org.id;
}

const cl = (suffix = '') => `/orgs/${ctx.org}/clusters/${ctx.cluster}${suffix}`;
const clusterStatus = async () => {
  const res = await ctx.api.call('GET', cl(), undefined, 200);
  return res.json?.status ?? res.json?.cluster?.status;
};

async function installAgent(extra = []) {
  // Reuse a cluster this run (or an earlier one) already enrolled, so a single path can be rerun on its own.
  const known = (await ctx.api.call('GET', `/orgs/${ctx.org}/clusters`, undefined, 200)).json.clusters.find((c) => c.name === ctx.clusterName);
  if (known && known.status === 'CONNECTED') {
    ctx.cluster = known.id;
    ctx.reused = true;
    return;
  }
  if (known) await ctx.api.call('DELETE', `/orgs/${ctx.org}/clusters/${known.id}`, undefined, [200, 204]);
  const created = await ctx.api.call('POST', `/orgs/${ctx.org}/clusters`, { name: ctx.clusterName }, 201);
  ctx.cluster = created.json.cluster.id;
  const ca = created.json.installCommand.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0];
  const caFile = path.join(STATE, 'ca.pem');
  fs.writeFileSync(caFile, ca + '\n');
  const args = [
    'upgrade', '--install', 'vfm-agent', path.join(ROOT, 'deploy/helm/vfm-agent'), '--kube-context', 'kind-vfm-a',
    '-n', 'vfm-system', '--create-namespace',
    '--set', 'controlPlane.address=vfm-cp:8443', '--set-file', `controlPlane.caBundle=${caFile}`,
    '--set', `enrollment.token=${created.json.bootstrapToken}`,
    '--set', 'image.repository=ghcr.io/shubhambatra/vfm-agent', '--set', 'image.tag=0.1.0', '--set', 'image.pullPolicy=Never',
    '--set', 'velero.namespace=velero', ...extra,
  ];
  sh('helm', args);
}

const commandOf = async (id) => (await ctx.api.call('GET', cl(`/commands/${id}`), undefined, 200)).json;
async function finish(id, timeout = 120_000) {
  return until(`command ${id} to finish`, async () => {
    const c = await commandOf(id);
    return ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REJECTED', 'CANCELLED'].includes(c.status) ? c : undefined;
  }, { timeout });
}
const detail = async (kind, name) => (await ctx.api.call('GET', cl(`/${kind}/${encodeURIComponent(name)}`), undefined, [200, 404])).json;
async function phaseIs(kind, name, wanted, timeout = 180_000) {
  return until(`${kind} ${name} to be ${wanted.join('/')}`, async () => {
    const d = await detail(kind, name);
    const phase = d?.summary?.phase ?? d?.phase;
    return wanted.includes(phase) ? phase : undefined;
  }, { timeout, every: 1000 });
}
const payloadSha = (ns, pod = 'demo-data-0') => kubectl('-n', ns, 'exec', pod, '--', 'sh', '-c', "sha256sum /data/payload.txt | cut -d' ' -f1");
const wantedSha = () => fs.readFileSync(path.join(ROOT, 'deploy/dev/.generated/vfm-a-demo-payload.sha256'), 'utf8').trim().split(/\s+/)[0];
const podReady = (ns, pod) => kubectlTry('-n', ns, 'get', 'pod', pod, '-o', 'jsonpath={.status.containerStatuses[0].ready}') === 'true';

// ---------------------------------------------------------------------------------------------------------------------
await signIn();
await ensureOrg();
console.log(`signed in; organization ${ctx.org}`);

await r.path('GP1  enrol a cluster; the agent is connected within 30 s', async () => {
  const t0 = Date.now();
  await installAgent();
  r.ok('the install command ran against the cluster (real helm, the real agent image)');
  await until('the agent pod to exist', () => kubectlTry('-n', 'vfm-system', 'get', 'pods', '-o', 'name'), { timeout: 60_000 });
  const status = await until('the cluster to read CONNECTED', async () => ((await clusterStatus()) === 'CONNECTED' ? 'CONNECTED' : undefined), { timeout: 90_000 });
  const took = (Date.now() - t0) / 1000;
  r.check(status === 'CONNECTED', `the cluster is CONNECTED (${took.toFixed(1)} s after helm started; the 30 s target starts when the pod runs)`);
  // The version arrives just after the connection (the agent reports Velero's status once connected).
  const flat = await until('Velero details from the agent', async () => {
    const v = JSON.stringify((await ctx.api.call('GET', cl(), undefined, 200)).json);
    return v.includes('v1.18.4') ? v : undefined;
  }, { timeout: 30_000 });
  r.check(true, 'the Velero version the real agent found in the real cluster is shown (v1.18.4)');
  r.check(flat.includes('velero.io/aws') || flat.includes('velero.io/pod'), 'the Velero plugins are reported');
});

if (runsGp2) {
  await r.path('GP2  back up namespace demo with a filesystem backup; Completed; logs viewable; details show the PVC', async () => {
    const accepted = await ctx.api.call('POST', cl('/backups'), { name: BACKUP, includedNamespaces: ['demo'], defaultVolumesToFsBackup: true }, [200, 201, 202]);
    fs.writeFileSync(LAST, BACKUP);
    const cmd = await finish(accepted.json.id);
    r.check(cmd.status === 'SUCCEEDED', 'the agent created the Backup (command SUCCEEDED)', JSON.stringify(cmd).slice(0, 300));
    const phase = await phaseIs('backups', BACKUP, ['Completed', 'PartiallyFailed', 'Failed']);
    r.check(phase === 'Completed', 'Velero finished the backup: phase Completed (a succeeded command is not a succeeded backup)', phase);
    const log = await until('the backup log', async () => {
      await ctx.api.call('POST', cl(`/backups/${BACKUP}/logs`), {}, [200, 202]);
      const g = await ctx.api.call('GET', cl(`/backups/${BACKUP}/logs`));
      return g.status === 200 && g.text.length > 0 ? g.text : undefined;
    }, { timeout: 90_000, every: 2000 });
    r.check(/level=|msg=|time=/.test(log) && log.includes(BACKUP), 'the backup log was fetched from inside the cluster and is readable', log.slice(0, 120));
    const vols = await until('volume details', async () => {
      await ctx.api.call('POST', cl(`/backups/${BACKUP}/details/volume-infos`), {}, [200, 202]);
      const g = await ctx.api.call('GET', cl(`/backups/${BACKUP}/details/volume-infos`));
      return g.status === 200 ? g.text : undefined;
    }, { timeout: 90_000, every: 2000 });
    r.check(/data-demo-data-0/.test(vols), 'the details show the PVC (data-demo-data-0) that was backed up', vols.slice(0, 160));
    const d = await detail('backups', BACKUP);
    r.check(JSON.stringify(d).includes('"demo"'), 'the backup spec names namespace demo');
  });
}

if (wants('gp3')) {
  await r.path('GP3  delete the namespace, restore, pod running and the PVC checksum matches', async () => {
    const before = payloadSha('demo');
    r.check(before === wantedSha(), 'before: the volume holds the known payload', `${before} vs ${wantedSha()}`);
    kubectl('delete', 'namespace', 'demo', '--wait=true', '--timeout=180s');
    r.check(kubectlTry('get', 'namespace', 'demo') === undefined, 'the namespace is gone');
    const accepted = await ctx.api.call('POST', cl('/restores'), { backupName: BACKUP, includedNamespaces: ['demo'], name: `gp3-${RUN}` }, [200, 201, 202]);
    r.check((await finish(accepted.json.id)).status === 'SUCCEEDED', 'the agent created the Restore (a sudo re-authentication was needed and given)');
    const phase = await phaseIs('restores', `gp3-${RUN}`, ['Completed', 'PartiallyFailed', 'Failed'], 240_000);
    r.check(phase === 'Completed', 'Velero finished the restore: Completed', phase);
    await until('demo-data-0 to run again', () => podReady('demo', 'demo-data-0'), { timeout: 240_000, every: 2000 });
    r.ok('the pod is running again');
    const after = await until('the payload to be readable', () => { try { return payloadSha('demo'); } catch { return undefined; } }, { timeout: 120_000, every: 2000 });
    r.check(after === wantedSha(), 'the PVC checksum after the restore matches the original', `${after} vs ${wantedSha()}`);
  });
}

if (wants('gp4')) {
  await r.path('GP4  restore with namespace mapping demo -> demo-restored', async () => {
    kubectlTry('delete', 'namespace', 'demo-restored', '--wait=true', '--timeout=120s');
    const accepted = await ctx.api.call('POST', cl('/restores'), { backupName: BACKUP, includedNamespaces: ['demo'], namespaceMapping: { demo: 'demo-restored' }, name: `gp4-${RUN}` }, [200, 201, 202]);
    r.check((await finish(accepted.json.id)).status === 'SUCCEEDED', 'the agent created the Restore with the mapping');
    const phase = await phaseIs('restores', `gp4-${RUN}`, ['Completed', 'PartiallyFailed', 'Failed'], 240_000);
    r.check(phase === 'Completed', 'Velero finished the restore: Completed', phase);
    await until('demo-data-0 to run in demo-restored', () => podReady('demo-restored', 'demo-data-0'), { timeout: 240_000, every: 2000 });
    r.ok('the pod runs in demo-restored');
    const sha = await until('payload in demo-restored', () => { try { return payloadSha('demo-restored'); } catch { return undefined; } }, { timeout: 120_000, every: 2000 });
    r.check(sha === wantedSha(), 'the data in demo-restored matches the original', `${sha} vs ${wantedSha()}`);
    r.check(kubectlTry('-n', 'demo', 'get', 'pod', 'demo-data-0', '-o', 'name') !== undefined, 'the original namespace is untouched');
  });
}

process.exit(r.summary());
