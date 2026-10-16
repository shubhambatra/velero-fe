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
