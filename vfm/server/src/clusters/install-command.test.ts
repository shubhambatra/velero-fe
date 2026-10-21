import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { buildInstallCommand, type InstallCommandInput } from './install-command';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBabc+/=\n-----END CERTIFICATE-----\n';
const base: InstallCommandInput = {
  chartRef: 'oci://ghcr.io/example/charts/vfm-agent',
  gatewayAddress: 'vfm.example.com:8443',
  caBundlePem: CA,
  bootstrapToken: 'a'.repeat(43),
  clusterName: 'prod-eu',
};

describe('buildInstallCommand', () => {
  it('writes the CA, then installs with the address, the CA file and the token', () => {
    const out = buildInstallCommand(base);
    expect(out).toContain("cat > vfm-ca.pem <<'VFM_CA'");
    expect(out).toContain('--set controlPlane.address=vfm.example.com:8443');
    expect(out).toContain('--set-file controlPlane.caBundle=vfm-ca.pem');
    expect(out).toContain(`--set enrollment.token=${'a'.repeat(43)}`);
    expect(out.indexOf('VFM_CA\n\nhelm')).toBeGreaterThan(out.indexOf('BEGIN CERTIFICATE'));
  });

  it.each([
    ['token', { bootstrapToken: 'x; rm -rf /' }],
    ['address', { gatewayAddress: 'a.com:8443 && curl evil' }],
    ['chart', { chartRef: 'oci://x/y $(id)' }],
    ['CA', { caBundlePem: `${CA}\nVFM_CA\nrm -rf /` }],
  ])('refuses a %s that could break out of the command', (_name, override) => {
    expect(() => buildInstallCommand({ ...base, ...override })).toThrow();
  });

  it('cannot be broken out of through the cluster name, which only appears in a comment', () => {
    const out = buildInstallCommand({ ...base, clusterName: 'x\nrm -rf /' });
    expect(out.split('\n').filter((line) => line.startsWith('rm'))).toEqual([]);
  });
});

/**
 * The command tells an operator to type `--set controlPlane.address=...` and so on.
 * Those names are only meaningful if the agent's chart actually has them, so this
 * reads the real chart rather than trusting that two hand-written lists agree.
 */
describe('buildInstallCommand against the agent chart', () => {
  const values = parse(
    readFileSync(resolve(__dirname, '../../../deploy/helm/vfm-agent/values.yaml'), 'utf8'),
  ) as Record<string, Record<string, unknown>>;

  const keysSet = (command: string): string[] =>
    [...command.matchAll(/--set(?:-file)? ([A-Za-z0-9.]+)=/g)].map((m) => m[1] ?? '');

  it('only sets values the chart defines', () => {
    const out = buildInstallCommand(base);
    const keys = keysSet(out);
    expect(keys).toEqual(
      expect.arrayContaining(['controlPlane.address', 'controlPlane.caBundle', 'enrollment.token']),
    );
    for (const key of keys) {
      const [section, name] = key.split('.');
      expect(values[section ?? ''], `section ${section ?? ''}`).toBeDefined();
      expect(Object.keys(values[section ?? ''] ?? {}), key).toContain(name);
    }
  });

  it('installs into the namespace the agent and its RBAC are written for', () => {
    expect(buildInstallCommand(base)).toContain('--namespace vfm-system --create-namespace');
  });
});
