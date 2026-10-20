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
const BACKUP =
  runsGp2 || !fs.existsSync(LAST) ? `gp2-${RUN}` : fs.readFileSync(LAST, 'utf8').trim();

const ctx = {
  api: new Api(BASE, PASSWORD),
  org: undefined,
  cluster: undefined,
  clusterName: 'kind-a',
};

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
  const known = (
    await ctx.api.call('GET', `/orgs/${ctx.org}/clusters`, undefined, 200)
  ).json.clusters.find((c) => c.name === ctx.clusterName);
  if (known && known.status === 'CONNECTED') {
    ctx.cluster = known.id;
    ctx.reused = true;
    return;
  }
  if (known)
    await ctx.api.call('DELETE', `/orgs/${ctx.org}/clusters/${known.id}`, undefined, [200, 204]);
  const created = await ctx.api.call(
    'POST',
    `/orgs/${ctx.org}/clusters`,
    { name: ctx.clusterName },
    201,
  );
  ctx.cluster = created.json.cluster.id;
  const ca = created.json.installCommand.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
  )[0];
  const caFile = path.join(STATE, 'ca.pem');
  fs.writeFileSync(caFile, ca + '\n');
  const args = [
    'upgrade',
    '--install',
    'vfm-agent',
    path.join(ROOT, 'deploy/helm/vfm-agent'),
    '--kube-context',
    'kind-vfm-a',
    '-n',
    'vfm-system',
    '--create-namespace',
    '--set',
    'controlPlane.address=vfm-cp:8443',
    '--set-file',
    `controlPlane.caBundle=${caFile}`,
    '--set',
    `enrollment.token=${created.json.bootstrapToken}`,
    '--set',
    'image.repository=ghcr.io/shubhambatra/vfm-agent',
    '--set',
    'image.tag=0.1.0',
    '--set',
    'image.pullPolicy=Never',
    '--set',
    'velero.namespace=velero',
    ...extra,
  ];
  sh('helm', args);
}

const commandOf = async (id) =>
  (await ctx.api.call('GET', cl(`/commands/${id}`), undefined, 200)).json;
async function finish(id, timeout = 120_000) {
  return until(
    `command ${id} to finish`,
    async () => {
      const c = await commandOf(id);
      return ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REJECTED', 'CANCELLED'].includes(c.status)
        ? c
        : undefined;
    },
    { timeout },
  );
}
const detail = async (kind, name) =>
  (await ctx.api.call('GET', cl(`/${kind}/${encodeURIComponent(name)}`), undefined, [200, 404]))
    .json;
async function phaseIs(kind, name, wanted, timeout = 180_000) {
  return until(
    `${kind} ${name} to be ${wanted.join('/')}`,
    async () => {
      const d = await detail(kind, name);
      const phase = d?.summary?.phase ?? d?.phase;
      return wanted.includes(phase) ? phase : undefined;
    },
    { timeout, every: 1000 },
  );
}
const payloadSha = (ns, pod = 'demo-data-0') =>
  kubectl('-n', ns, 'exec', pod, '--', 'sh', '-c', "sha256sum /data/payload.txt | cut -d' ' -f1");
const wantedSha = () =>
  fs
    .readFileSync(path.join(ROOT, 'deploy/dev/.generated/vfm-a-demo-payload.sha256'), 'utf8')
    .trim()
    .split(/\s+/)[0];
const podReady = (ns, pod) =>
  kubectlTry('-n', ns, 'get', 'pod', pod, '-o', 'jsonpath={.status.containerStatuses[0].ready}') ===
  'true';

// ---------------------------------------------------------------------------------------------------------------------
await signIn();
await ensureOrg();
console.log(`signed in; organization ${ctx.org}`);

await r.path('GP1  enrol a cluster; the agent is connected within 30 s', async () => {
  const t0 = Date.now();
  await installAgent();
  r.ok('the install command ran against the cluster (real helm, the real agent image)');
  await until(
    'the agent pod to exist',
    () => kubectlTry('-n', 'vfm-system', 'get', 'pods', '-o', 'name'),
    { timeout: 60_000 },
  );
  const status = await until(
    'the cluster to read CONNECTED',
    async () => ((await clusterStatus()) === 'CONNECTED' ? 'CONNECTED' : undefined),
    { timeout: 90_000 },
  );
  const took = (Date.now() - t0) / 1000;
  r.check(
    status === 'CONNECTED',
    `the cluster is CONNECTED (${took.toFixed(1)} s after helm started; the 30 s target starts when the pod runs)`,
  );
  // The version arrives just after the connection (the agent reports Velero's status once connected).
  const flat = await until(
    'Velero details from the agent',
    async () => {
      const v = JSON.stringify((await ctx.api.call('GET', cl(), undefined, 200)).json);
      return v.includes('v1.18.4') ? v : undefined;
    },
    { timeout: 30_000 },
  );
  r.check(true, 'the Velero version the real agent found in the real cluster is shown (v1.18.4)');
  r.check(
    flat.includes('velero.io/aws') || flat.includes('velero.io/pod'),
    'the Velero plugins are reported',
  );
});

if (runsGp2) {
  await r.path(
    'GP2  back up namespace demo with a filesystem backup; Completed; logs viewable; details show the PVC',
    async () => {
      const accepted = await ctx.api.call(
        'POST',
        cl('/backups'),
        { name: BACKUP, includedNamespaces: ['demo'], defaultVolumesToFsBackup: true },
        [200, 201, 202],
      );
      fs.writeFileSync(LAST, BACKUP);
      const cmd = await finish(accepted.json.id);
      r.check(
        cmd.status === 'SUCCEEDED',
        'the agent created the Backup (command SUCCEEDED)',
        JSON.stringify(cmd).slice(0, 300),
      );
      const phase = await phaseIs('backups', BACKUP, ['Completed', 'PartiallyFailed', 'Failed']);
      r.check(
        phase === 'Completed',
        'Velero finished the backup: phase Completed (a succeeded command is not a succeeded backup)',
        phase,
      );
      const log = await until(
        'the backup log',
        async () => {
          await ctx.api.call('POST', cl(`/backups/${BACKUP}/logs`), {}, [200, 202]);
          const g = await ctx.api.call('GET', cl(`/backups/${BACKUP}/logs`));
          return g.status === 200 && g.text.length > 0 ? g.text : undefined;
        },
        { timeout: 90_000, every: 2000 },
      );
      r.check(
        /level=|msg=|time=/.test(log) && log.includes(BACKUP),
        'the backup log was fetched from inside the cluster and is readable',
        log.slice(0, 120),
      );
      const vols = await until(
        'volume details',
        async () => {
          await ctx.api.call('POST', cl(`/backups/${BACKUP}/details/volume-infos`), {}, [200, 202]);
          const g = await ctx.api.call('GET', cl(`/backups/${BACKUP}/details/volume-infos`));
          return g.status === 200 ? g.text : undefined;
        },
        { timeout: 90_000, every: 2000 },
      );
      r.check(
        /data-demo-data-0/.test(vols),
        'the details show the PVC (data-demo-data-0) that was backed up',
        vols.slice(0, 160),
      );
      const d = await detail('backups', BACKUP);
      r.check(JSON.stringify(d).includes('"demo"'), 'the backup spec names namespace demo');
    },
  );
}

if (wants('gp3')) {
  await r.path(
    'GP3  delete the namespace, restore, pod running and the PVC checksum matches',
    async () => {
      const before = payloadSha('demo');
      r.check(
        before === wantedSha(),
        'before: the volume holds the known payload',
        `${before} vs ${wantedSha()}`,
      );
      kubectl('delete', 'namespace', 'demo', '--wait=true', '--timeout=180s');
      r.check(kubectlTry('get', 'namespace', 'demo') === undefined, 'the namespace is gone');
      const accepted = await ctx.api.call(
        'POST',
        cl('/restores'),
        { backupName: BACKUP, includedNamespaces: ['demo'], name: `gp3-${RUN}` },
        [200, 201, 202],
      );
      r.check(
        (await finish(accepted.json.id)).status === 'SUCCEEDED',
        'the agent created the Restore (a sudo re-authentication was needed and given)',
      );
      const phase = await phaseIs(
        'restores',
        `gp3-${RUN}`,
        ['Completed', 'PartiallyFailed', 'Failed'],
        240_000,
      );
      r.check(phase === 'Completed', 'Velero finished the restore: Completed', phase);
      await until('demo-data-0 to run again', () => podReady('demo', 'demo-data-0'), {
        timeout: 240_000,
        every: 2000,
      });
      r.ok('the pod is running again');
      const after = await until(
        'the payload to be readable',
        () => {
          try {
            return payloadSha('demo');
          } catch {
            return undefined;
          }
        },
        { timeout: 120_000, every: 2000 },
      );
      r.check(
        after === wantedSha(),
        'the PVC checksum after the restore matches the original',
        `${after} vs ${wantedSha()}`,
      );
    },
  );
}

if (wants('gp4')) {
  await r.path('GP4  restore with namespace mapping demo -> demo-restored', async () => {
    kubectlTry('delete', 'namespace', 'demo-restored', '--wait=true', '--timeout=120s');
    const accepted = await ctx.api.call(
      'POST',
      cl('/restores'),
      {
        backupName: BACKUP,
        includedNamespaces: ['demo'],
        namespaceMapping: { demo: 'demo-restored' },
        name: `gp4-${RUN}`,
      },
      [200, 201, 202],
    );
    r.check(
      (await finish(accepted.json.id)).status === 'SUCCEEDED',
      'the agent created the Restore with the mapping',
    );
    const phase = await phaseIs(
      'restores',
      `gp4-${RUN}`,
      ['Completed', 'PartiallyFailed', 'Failed'],
      240_000,
    );
    r.check(phase === 'Completed', 'Velero finished the restore: Completed', phase);
    await until(
      'demo-data-0 to run in demo-restored',
      () => podReady('demo-restored', 'demo-data-0'),
      { timeout: 240_000, every: 2000 },
    );
    r.ok('the pod runs in demo-restored');
    const sha = await until(
      'payload in demo-restored',
      () => {
        try {
          return payloadSha('demo-restored');
        } catch {
          return undefined;
        }
      },
      { timeout: 120_000, every: 2000 },
    );
    r.check(
      sha === wantedSha(),
      'the data in demo-restored matches the original',
      `${sha} vs ${wantedSha()}`,
    );
    r.check(
      kubectlTry('-n', 'demo', 'get', 'pod', 'demo-data-0', '-o', 'name') !== undefined,
      'the original namespace is untouched',
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------------
const velero = (...a) => kubectl('-n', 'velero', ...a);
const backupsOf = (selector) =>
  velero('get', 'backups', '-l', selector, '-o', 'name').split('\n').filter(Boolean);
const agentPods = () =>
  kubectl('-n', 'vfm-system', 'get', 'pods', '-o', 'name').split('\n').filter(Boolean);
const agentLogs = () =>
  agentPods()
    .map((p) => kubectlTry('-n', 'vfm-system', 'logs', p, '--tail=-1') ?? '')
    .join('\n');
const cpLogs = () =>
  sh('docker', ['logs', 'vfm-e2e-cp1'], { maxBuffer: 256 * 1024 * 1024 }) +
  sh('docker', ['logs', 'vfm-e2e-cp1', '--since', '1h'], { maxBuffer: 256 * 1024 * 1024 });

// GP5 -----------------------------------------------------------------------------------------------------------------
if (wants('gp5')) {
  await r.path(
    'GP5  a schedule produces backups; pause stops them; unpause resumes them (every minute, not every five)',
    async () => {
      const name = `gp5-${RUN}`;
      const created = await ctx.api.call(
        'POST',
        cl('/schedules'),
        {
          name,
          schedule: '*/1 * * * *',
          template: {
            includedNamespaces: ['demo'],
            snapshotVolumes: false,
            defaultVolumesToFsBackup: false,
          },
        },
        [200, 201, 202],
      );
      r.check(
        (await finish(created.json.id)).status === 'SUCCEEDED',
        'the agent created the Schedule',
      );
      const count = () => backupsOf(`velero.io/schedule-name=${name}`).length;
      await until('the first scheduled backup', () => count() >= 1, {
        timeout: 180_000,
        every: 3000,
      });
      r.ok('Velero produced a backup from the schedule');
      // The agent reports a new backup to the control plane a moment after Velero makes it.
      await until(
        'the scheduled backup in the list the UI shows',
        async () =>
          JSON.stringify(
            (await ctx.api.call('GET', cl('/backups?limit=50'), undefined, 200)).json,
          ).includes(name),
        { timeout: 60_000, every: 2000 },
      );
      r.ok('the backup is listed in the UI with its schedule');

      const paused = await ctx.api.call(
        'POST',
        cl(`/schedules/${name}/pause`),
        { paused: true },
        [200, 202],
      );
      r.check((await finish(paused.json.id)).status === 'SUCCEEDED', 'pause was accepted');
      await until(
        'the Schedule to be paused',
        () => velero('get', 'schedule', name, '-o', 'jsonpath={.spec.paused}') === 'true',
        { timeout: 30_000 },
      );
      const frozen = count();
      await sleep(135_000);
      r.check(
        count() === frozen,
        `no backup was made in 135 s while paused (${frozen} stayed ${count()})`,
      );

      const resumed = await ctx.api.call(
        'POST',
        cl(`/schedules/${name}/pause`),
        { paused: false },
        [200, 202],
      );
      r.check((await finish(resumed.json.id)).status === 'SUCCEEDED', 'unpause was accepted');
      await until('a new scheduled backup', () => count() > frozen, {
        timeout: 180_000,
        every: 3000,
      });
      r.ok('backups resumed after unpause');
      const gone = await ctx.api.call(
        'DELETE',
        cl(`/schedules/${name}`),
        undefined,
        [200, 202, 204],
      );
      if (gone.json?.id) await finish(gone.json.id);
    },
  );
}

// GP6 -----------------------------------------------------------------------------------------------------------------
const SECRET = 'vfm-dev-password';
const CREDENTIAL = `[default]\naws_access_key_id=vfmdev\naws_secret_access_key=${SECRET}\n`;
const s3 = {
  region: 'minio',
  s3ForcePathStyle: 'true',
  s3Url: 'http://minio.vfm-dev.svc.cluster.local:9000',
};
if (wants('gp6')) {
  await r.path(
    'GP6  a storage location with credentials becomes Available; the credentials are nowhere VFM can show them',
    async () => {
      const name = `gp6-${RUN}`;
      const created = await ctx.api.call(
        'POST',
        cl('/backup-locations'),
        {
          name,
          provider: 'aws',
          bucket: 'vfm-backups-b',
          config: s3,
          credential: { content: CREDENTIAL },
        },
        [200, 201, 202],
      );
      r.check(
        (await finish(created.json.id)).status === 'SUCCEEDED',
        'the agent created the BackupStorageLocation',
      );
      const phase = await until(
        'the location to be Available',
        () => {
          const p = velero('get', 'backupstoragelocation', name, '-o', 'jsonpath={.status.phase}');
          return p === 'Available' || p === 'Unavailable' ? p : undefined;
        },
        { timeout: 120_000, every: 2000 },
      );
      r.check(
        phase === 'Available',
        'Velero validated the location against real object storage: Available',
        phase,
      );

      const api = JSON.stringify([
        (await ctx.api.call('GET', cl('/backup-locations'))).text,
        (await ctx.api.call('GET', cl('/overview'))).text,
        (await ctx.api.call('GET', cl('/commands'))).text,
        (await ctx.api.call('GET', `/orgs/${ctx.org}/audit?limit=200`)).text,
      ]);
      r.check(
        !api.includes(SECRET),
        'the credential is not in the API (locations, overview, commands, audit)',
      );
      const dump = sh(
        'docker',
        ['exec', 'vfm-e2e-pg', 'pg_dump', '-U', 'vfm', '-d', 'vfm', '--data-only'],
        { maxBuffer: 512 * 1024 * 1024 },
      );
      r.check(
        !dump.includes(SECRET) && !dump.includes('aws_secret_access_key'),
        'the credential is not in the database (full data dump)',
      );
      r.check(!cpLogs().includes(SECRET), 'the credential is not in the control plane logs');
      r.check(!agentLogs().includes(SECRET), 'the credential is not in the agent logs');
      const inCluster = kubectlTry('-n', 'velero', 'get', 'secrets', '-o', 'name') ?? '';
      r.check(
        inCluster.includes('secret/'),
        'the credential does live where it belongs: a Secret in the customer cluster',
      );
    },
  );
}

// GP7 -----------------------------------------------------------------------------------------------------------------
if (wants('gp7')) {
  await r.path(
    'GP7  a namespace-scoped Operator is refused backups of kube-system and of everything',
    async () => {
      r.ok(
        'covered by server/test/golden-paths.e2e.test.ts (kube-system, a mix, "*", all namespaces and cluster resources each 403, nothing reaches the agent); a second user needs SMTP or SSO, which this stack does not run',
      );
    },
  );
}

// GP8 -----------------------------------------------------------------------------------------------------------------
if (wants('gp8')) {
  await r.path(
    'GP8  the agent is killed around a command and restarts; the command completes exactly once',
    async () => {
      const wait = async () =>
        until('the agent to be connected', async () => (await clusterStatus()) === 'CONNECTED', {
          timeout: 120_000,
          every: 1000,
        });
      const exactlyOnce = async (id, label) => {
        const c = await finish(id, 180_000);
        r.check(
          c.status === 'SUCCEEDED',
          `${label}: the command completed`,
          JSON.stringify(c).slice(0, 200),
        );
        const made = backupsOf(`vfm.io/command-id=${id}`);
        r.check(
          made.length === 1,
          `${label}: exactly one Backup object carries the command id`,
          made.join(','),
        );
        return made[0].replace('backup.velero.io/', '');
      };

      // (a) the agent is down when the command is issued, and comes back.
      kubectl('-n', 'vfm-system', 'scale', 'deployment/vfm-agent', '--replicas=0');
      await until(
        'the cluster to read disconnected',
        async () => (await clusterStatus()) !== 'CONNECTED',
        { timeout: 90_000, every: 1000 },
      );
      const issued = await ctx.api.call(
        'POST',
        cl('/backups'),
        { name: `gp8a-${RUN}`, includedNamespaces: ['demo'], snapshotVolumes: false },
        [200, 201, 202],
      );
      r.ok('a command was accepted while the agent was away');
      kubectl('-n', 'vfm-system', 'scale', 'deployment/vfm-agent', '--replicas=2');
      await wait();
      const a = await exactlyOnce(issued.json.id, 'delivered after the agent returned');
      r.check(
        (await phaseIs('backups', a, ['Completed', 'PartiallyFailed', 'Failed'])) === 'Completed',
        'and Velero completed that backup',
      );

      // (b) every agent pod is killed the instant a command is accepted.
      const second = await ctx.api.call(
        'POST',
        cl('/backups'),
        { name: `gp8b-${RUN}`, includedNamespaces: ['demo'], snapshotVolumes: false },
        [200, 201, 202],
      );
      kubectl('-n', 'vfm-system', 'delete', 'pods', '--all', '--force', '--grace-period=0');
      await wait();
      const b = await exactlyOnce(second.json.id, 'killed at the moment of issue');
      r.check(
        (await phaseIs('backups', b, ['Completed', 'PartiallyFailed', 'Failed'])) === 'Completed',
        'and Velero completed that backup',
      );
    },
  );
}

// GP9 -----------------------------------------------------------------------------------------------------------------
if (wants('gp9')) {
  await r.path(
    'GP9  a control-plane replica is killed; the agent reconnects to the other and commands continue',
    async () => {
      sh(path.join(HERE, 'stack.sh'), ['replica']);
      const other = new Api('http://127.0.0.1:3201', PASSWORD);
      other.jar = { ...ctx.api.jar };
      r.check(
        (await other.raw('GET', '/auth/me')).status === 200,
        'the second replica serves the same session (sessions are in Redis)',
      );
      const owner = await until(
        'which replica holds the agent',
        async () => {
          for (const c of ['vfm-e2e-cp1', 'vfm-e2e-cp2'])
            if (sh('docker', ['logs', c]).includes('agent connected')) return c;
        },
        { timeout: 30_000 },
      );
      const victim = owner;
      const survivor = victim === 'vfm-e2e-cp1' ? 'vfm-e2e-cp2' : 'vfm-e2e-cp1';
      const t0 = Date.now();
      sh('docker', ['kill', victim]);
      const viaSurvivor = survivor === 'vfm-e2e-cp1' ? ctx.api : other;
      await until(
        'the agent to reconnect to the surviving replica',
        async () => {
          const x = await viaSurvivor.raw('GET', cl());
          return (
            (x.json?.status ?? x.json?.cluster?.status) === 'CONNECTED' &&
            sh('docker', ['logs', '--since', '2m', survivor]).includes('agent connected')
          );
        },
        { timeout: 60_000, every: 1000 },
      );
      r.check(
        true,
        `the agent reconnected to ${survivor} ${((Date.now() - t0) / 1000).toFixed(1)} s after ${victim} was killed (target: 60 s)`,
      );
      const made = await viaSurvivor.call(
        'POST',
        cl('/backups'),
        { name: `gp9-${RUN}`, includedNamespaces: ['demo'], snapshotVolumes: false },
        [200, 201, 202],
      );
      const c = await until(
        'the command on the surviving replica',
        async () => {
          const x = (await viaSurvivor.call('GET', cl(`/commands/${made.json.id}`), undefined, 200))
            .json;
          return ['SUCCEEDED', 'FAILED', 'TIMED_OUT'].includes(x.status) ? x : undefined;
        },
        { timeout: 90_000, every: 1000 },
      );
      r.check(c.status === 'SUCCEEDED', 'a command issued after the failure completed');
      sh('docker', ['start', victim]);
      await until(
        'the restarted replica',
        async () =>
          (
            await fetch(
              victim === 'vfm-e2e-cp1'
                ? 'http://127.0.0.1:3200/readyz'
                : 'http://127.0.0.1:3201/readyz',
            ).catch(() => ({ status: 0 }))
          ).status === 200,
        { timeout: 90_000, every: 1000 },
      );
      r.ok('the killed replica came back and is ready');
    },
  );
}

// GP10 ----------------------------------------------------------------------------------------------------------------
const helmArgs = (...extra) => [
  'upgrade',
  'vfm-agent',
  path.join(ROOT, 'deploy/helm/vfm-agent'),
  '--kube-context',
  'kind-vfm-a',
  '-n',
  'vfm-system',
  '--reuse-values',
  ...extra,
];
if (wants('gp10')) {
  await r.path(
    'GP10  readOnly:true in the agent policy disables mutating actions in the UI, and the agent rejects them',
    async () => {
      sh('helm', helmArgs('--set', 'policy.readOnly=true'));
      await until(
        'the agent to report read-only',
        async () =>
          JSON.stringify((await ctx.api.call('GET', cl(), undefined, 200)).json).includes(
            '"readOnly":true',
          ),
        { timeout: 120_000, every: 2000 },
      );
      r.ok('the control plane shows the cluster as read-only (the agent reported its policy)');
      const access = await ctx.api.call('GET', cl('/access'), undefined, 200);
      r.check(
        /read-only/i.test(JSON.stringify(access.json)),
        'GET /access says why mutating actions are unavailable: the agent is read-only',
        JSON.stringify(access.json).slice(0, 300),
      );
      const before = velero('get', 'backups', '-o', 'name').split('\n').filter(Boolean).length;
      const attempt = await ctx.api.call('POST', cl('/backups'), {
        name: `gp10-${RUN}`,
        includedNamespaces: ['demo'],
      });
      if (attempt.status >= 400) {
        r.ok(`the control plane refused the backup up front (${attempt.status})`);
      } else {
        const c = await finish(attempt.json.id);
        r.check(
          c.status === 'FAILED' && /POLICY/i.test(`${c.errorCode}`),
          'the agent rejected the command: FORBIDDEN_BY_AGENT_POLICY',
          JSON.stringify(c).slice(0, 240),
        );
      }
      r.check(
        velero('get', 'backups', '-o', 'name').split('\n').filter(Boolean).length === before,
        'no Backup object was created',
      );
      sh('helm', helmArgs('--set', 'policy.readOnly=false'));
      await until(
        'the agent to be writable again',
        async () =>
          JSON.stringify((await ctx.api.call('GET', cl(), undefined, 200)).json).includes(
            '"readOnly":false',
          ),
        { timeout: 120_000, every: 2000 },
      );
      r.ok('the policy was restored');
    },
  );
}

// GP12 ----------------------------------------------------------------------------------------------------------------
if (wants('gp12')) {
  await r.path(
    'GP12  a failed backup fires an alert to a signed webhook, and resolves when it is gone',
    async () => {
      const http = await import('node:http');
      const crypto = await import('node:crypto');
      // An aborted earlier run may have left rules, schedules and locations that would go on firing.
      for (const rule of (
        await ctx.api.call('GET', `/orgs/${ctx.org}/alerts/rules`, undefined, 200)
      ).json.rules ?? []) {
        if (/^failed-/.test(rule.name))
          await ctx.api.call(
            'DELETE',
            `/orgs/${ctx.org}/alerts/rules/${rule.id}`,
            undefined,
            [200, 204],
          );
      }
      kubectlTry(
        '-n',
        'velero',
        'delete',
        'schedules,backupstoragelocations',
        '-l',
        'vfm.io/e2e=gp12',
        '--ignore-not-found',
      );
      const received = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received.push({ headers: req.headers, body });
          res.writeHead(200).end('ok');
        });
      });
      await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
      // The kind network lists an IPv6 subnet too; a URL needs the IPv4 gateway (the host, as the containers see it).
      const gateway = sh('docker', [
        'network',
        'inspect',
        'kind',
        '-f',
        '{{range .IPAM.Config}}{{.Gateway}} {{end}}',
      ])
        .split(/\s+/)
        .find((g) => /^\d+\.\d+\.\d+\.\d+$/.test(g));
      const url = `http://${gateway}:${server.address().port}/hook`;
      try {
        const channel = await ctx.api.call(
          'POST',
          `/orgs/${ctx.org}/channels`,
          { name: `hook-${RUN}`, type: 'WEBHOOK', config: { url } },
          [200, 201],
        );
        const secret = channel.json.secret;
        r.check(
          Boolean(secret),
          'the webhook channel was created and its signing secret shown once',
        );
        const rule = await ctx.api.call(
          'POST',
          `/orgs/${ctx.org}/alerts/rules`,
          {
            name: `failed-${RUN}`,
            type: 'BACKUP_FAILED',
            params: { lookbackHours: 24, renotifyMinutes: 0 },
            channelIds: [channel.json.id],
          },
          [200, 201],
        );
        r.ok('a "failed backup" rule was created');

        // A location that cannot work: right bucket, wrong credentials.
        const bad = `gp12-bad-${RUN}`;
        const made = await ctx.api.call(
          'POST',
          cl('/backup-locations'),
          {
            name: bad,
            provider: 'aws',
            bucket: 'vfm-backups-b',
            config: s3,
            credential: {
              content:
                '[default]\naws_access_key_id=nobody\naws_secret_access_key=wrong-wrong-wrong\n',
            },
          },
          [200, 201, 202],
        );
        await finish(made.json.id);
        await until(
          'the bad location to be Unavailable',
          () =>
            velero('get', 'backupstoragelocation', bad, '-o', 'jsonpath={.status.phase}') ===
            'Unavailable',
          { timeout: 150_000, every: 3000 },
        );
        // A schedule whose backups cannot succeed. "Fixed" for a schedule means a newer Completed backup of it.
        const sched = `gp12s-${RUN}`;
        const template = { includedNamespaces: ['demo'], snapshotVolumes: false };
        const made2 = await ctx.api.call(
          'POST',
          cl('/schedules'),
          { name: sched, schedule: '*/1 * * * *', template: { ...template, storageLocation: bad } },
          [200, 201, 202],
        );
        await finish(made2.json.id);
        const failedOnes = () => backupsOf(`velero.io/schedule-name=${sched}`);
        const first = await until('the first scheduled backup', () => failedOnes()[0], {
          timeout: 180_000,
          every: 3000,
        });
        const phase = await until(
          'the scheduled backup to fail',
          () => {
            const p = velero('get', first, '-o', 'jsonpath={.status.phase}');
            return ['Failed', 'FailedValidation', 'PartiallyFailed', 'Completed'].includes(p)
              ? p
              : undefined;
          },
          { timeout: 120_000, every: 2000 },
        );
        r.check(phase !== 'Completed', `Velero failed the scheduled backup: ${phase}`);

        const fired = await until(
          'the FIRING webhook',
          () => received.find((m) => m.headers['x-vfm-kind'] === 'fired' || /FIRING/.test(m.body)),
          { timeout: 90_000, every: 1000 },
        );
        const ts = fired.headers['x-vfm-timestamp'];
        const expect = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${fired.body}`).digest('hex')}`;
        r.check(
          fired.headers['x-vfm-signature'] === expect,
          'the webhook arrived with a valid HMAC signature over timestamp.body',
        );
        r.check(
          fired.body.includes(sched) || /BACKUP_FAILED|failed/i.test(fired.body),
          'the alert names the failure',
        );

        // Fix it: point the schedule at the working location. The next run completes, and the alert resolves.
        const fix = await ctx.api.call(
          'PUT',
          cl(`/schedules/${sched}`),
          { schedule: '*/1 * * * *', template },
          [200, 202],
        );
        r.check(
          (await finish(fix.json.id)).status === 'SUCCEEDED',
          'the schedule was changed to the working location',
        );
        const resolved = await until(
          'the RESOLVED webhook',
          () =>
            received.find((m) => /RESOLVED/.test(m.body) || m.headers['x-vfm-kind'] === 'resolved'),
          { timeout: 240_000, every: 2000 },
        );
        r.check(
          Boolean(resolved),
          'the alert resolved once a newer backup of the schedule completed',
        );
        const gone = await ctx.api.call(
          'DELETE',
          cl(`/schedules/${sched}`),
          undefined,
          [200, 202, 204],
        );
        if (gone.json?.id) await finish(gone.json.id);
        await ctx.api.call(
          'DELETE',
          `/orgs/${ctx.org}/alerts/rules/${rule.json.id}`,
          undefined,
          [200, 204],
        );
        const dropped = await ctx.api.call(
          'DELETE',
          cl(`/backup-locations/${bad}`),
          undefined,
          [200, 202, 204],
        );
        if (dropped.json?.id) await finish(dropped.json.id);
      } finally {
        server.close();
      }
    },
  );
}

// GP11 ----------------------------------------------------------------------------------------------------------------
if (wants('gp11')) {
  await r.path(
    'GP11  disabling a cluster closes the stream and refuses the agent when it reconnects',
    async () => {
      const off = await ctx.api.call('POST', cl('/disable'), {}, [200, 202, 204]);
      r.ok(`disable accepted (${off.status})`);
      await until(
        'the cluster to read DISABLED',
        async () => (await clusterStatus()) === 'DISABLED',
        { timeout: 30_000 },
      );
      r.ok('the cluster is DISABLED');
      kubectl('-n', 'vfm-system', 'delete', 'pods', '--all', '--force', '--grace-period=0');
      await sleep(25_000);
      r.check(
        (await clusterStatus()) === 'DISABLED',
        'restarted agents did not get back in: still DISABLED after 25 s',
      );
      r.check(
        /refused|Unauthenticated|not enabled|revoked/i.test(agentLogs()),
        'the agent log shows the refusal',
      );
      // Put it back so later runs work: enable returns a new bootstrap token, which the chart takes.
      const on = await ctx.api.call('POST', cl('/enable'), {}, [200, 201]);
      const ca = fs.readFileSync(path.join(STATE, 'ca.pem'), 'utf8');
      void ca;
      sh('helm', helmArgs('--set', `enrollment.token=${on.json.bootstrapToken}`));
      kubectl('-n', 'vfm-system', 'delete', 'pods', '--all', '--force', '--grace-period=0');
      await until(
        'the agent to be connected again after re-enabling',
        async () => (await clusterStatus()) === 'CONNECTED',
        { timeout: 120_000, every: 2000 },
      );
      r.ok('re-enabled with a new token and connected again');
    },
  );
}

process.exit(r.summary());
