export interface InstallCommandInput {
  chartRef: string;
  /** `host:port` of the agent gateway. */
  gatewayAddress: string;
  /** PEM of the internal CA, so the agent can pin the control plane. */
  caBundlePem: string;
  /** The one-time bootstrap token. Appears in the output; show it once. */
  bootstrapToken: string;
  clusterName: string;
}

/**
 * The copy-paste shell snippet the UI shows after "Add cluster" (PLAN.md §5.1
 * step 2). It is generated, never hand-assembled by callers, so quoting is done
 * in one reviewed place.
 *
 * Every interpolated value is validated first. The values come from our own
 * database or configuration, but they end up inside a command an operator pastes
 * into a shell with cluster-admin rights, so "probably safe" is not enough.
 */
export function buildInstallCommand(input: InstallCommandInput): string {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(input.bootstrapToken)) {
    throw new Error('bootstrap token has an unexpected shape');
  }
  if (!/^[A-Za-z0-9.:[\]-]+:\d{1,5}$/.test(input.gatewayAddress)) {
    throw new Error('gateway address must be host:port');
  }
  if (!/^[A-Za-z0-9./:_@+-]+$/.test(input.chartRef)) {
    throw new Error('chart reference contains characters that are not safe in a shell');
  }
  if (
    !/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?$/.test(
      input.caBundlePem,
    )
  ) {
    throw new Error('CA bundle is not a PEM certificate');
  }

  const pem = input.caBundlePem.endsWith('\n') ? input.caBundlePem : `${input.caBundlePem}\n`;

  return [
    `# Install the VFM agent on the cluster "${input.clusterName.replace(/[^\w .-]/g, '')}".`,
    '# The token is single-use and expires in 24 hours.',
    "cat > vfm-ca.pem <<'VFM_CA'",
    pem.trimEnd(),
    'VFM_CA',
    '',
    `helm install vfm-agent ${input.chartRef} \\`,
    '  --namespace vfm-system --create-namespace \\',
    `  --set controlPlane.address=${input.gatewayAddress} \\`,
    '  --set-file controlPlane.caBundle=vfm-ca.pem \\',
    `  --set enrollment.token=${input.bootstrapToken}`,
  ].join('\n');
}
