import type { Hello } from '../gateway/pb/vfm/agent/v1/gateway';

/**
 * What the control plane stores from an agent's `Hello`.
 *
 * The agent is **semi-trusted** (PLAN.md §12): a compromised cluster must not
 * be able to corrupt data or inject script into the UI. So nothing is stored as
 * sent. Strings are length-capped, lists are count-capped, and the result is
 * plain JSON of known shape. It is display data only and never an input to an
 * authorization decision; the UI still escapes it.
 */

/** The protocol versions this control plane accepts: the current one and the one before it (PLAN.md §5.7). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

export interface SanitizedHello {
  protocolVersion: number;
  agentVersion: string | null;
  kubernetesVersion: string | null;
  veleroVersion: string | null;
  veleroPlugins: { name: string; kind: string }[];
  capabilities: string[];
  agentPolicy: {
    allowRestore: boolean;
    restoreDeniedNamespaces: string[];
    allowBslWrite: boolean;
    allowLogStreaming: boolean;
    logStreamDeniedNamespaces: string[];
    readOnly: boolean;
    /** G-4: a restore must say includeClusterResources false. Absent (an older agent) is false: allowed. */
    denyClusterScopedRestore: boolean;
  };
  chartVersion: string | null;
  imageTag: string | null;
  fingerprint: string;
}

const MAX_TEXT = 128;
const MAX_ITEMS = 50;
const MAX_NAMESPACES = 100;

/** Printable ASCII and common Unicode letters; control characters are dropped, never echoed. */
export const clean = (value: string, max = MAX_TEXT): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);

const optional = (value: string): string | null => {
  const v = clean(value).trim();
  return v === '' ? null : v;
};

const list = (values: readonly string[], limit: number, max = MAX_TEXT): string[] =>
  values
    .slice(0, limit)
    .map((v) => clean(v, max).trim())
    .filter((v) => v !== '');

export function sanitizeHello(hello: Hello): SanitizedHello {
  const policy = hello.policy;
  return {
    protocolVersion: hello.protocolVersion,
    agentVersion: optional(hello.agentVersion),
    kubernetesVersion: optional(hello.kubernetesVersion),
    veleroVersion: optional(hello.velero?.serverVersion ?? ''),
    veleroPlugins: (hello.velero?.plugins ?? []).slice(0, MAX_ITEMS).map((p) => ({
      name: clean(p.name),
      kind: clean(p.kind),
    })),
    capabilities: list(hello.capabilities, MAX_ITEMS, 64),
    agentPolicy: {
      // An agent that sends no policy is reported as restricted, never open:
      // "unknown" must not display as "everything allowed".
      allowRestore: policy?.allowRestore ?? false,
      restoreDeniedNamespaces: list(policy?.restoreDeniedNamespaces ?? [], MAX_NAMESPACES, 63),
      allowBslWrite: policy?.allowBslWrite ?? false,
      allowLogStreaming: policy?.allowLogStreaming ?? false,
      logStreamDeniedNamespaces: list(policy?.logStreamDeniedNamespaces ?? [], MAX_NAMESPACES, 63),
      readOnly: policy?.readOnly ?? true,
      // No policy at all is restricted, like every other flag here; a policy from an older agent that
      // does not know the flag decodes as false, which is the behaviour it always had.
      denyClusterScopedRestore: policy?.denyClusterScopedRestore ?? true,
    },
    chartVersion: optional(hello.chartVersion),
    imageTag: optional(hello.imageTag),
    fingerprint: clean(hello.clusterFingerprint, 256),
  };
}

/** The Velero server status as reported by `RefreshServerStatus`, bounded like a Hello. */
export function sanitizeVeleroStatus(status: {
  serverVersion: string;
  plugins: readonly { name: string; kind: string }[];
}): { serverVersion: string | null; plugins: { name: string; kind: string }[] } {
  return {
    serverVersion: optional(status.serverVersion),
    plugins: status.plugins
      .slice(0, MAX_ITEMS)
      .map((p) => ({ name: clean(p.name), kind: clean(p.kind) })),
  };
}
