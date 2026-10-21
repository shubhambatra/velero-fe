/**
 * The Velero release window this build supports (PLAN.md §4.4).
 *
 * PLAN.md requires pinning the newest stable release as VELERO_PRIMARY and
 * supporting it plus the two previous minors. These values are mirrored in
 * vfm/Makefile (`make versions`) and docs/DECISIONS.md ADR-002; change all
 * three together.
 */

/** Newest stable Velero release, verified at project start. */
export const VELERO_PRIMARY = '1.18.4';

/**
 * Oldest supported minor. PLAN.md §18 Q4 defaults to primary minus two minors;
 * the e2e matrix runs against VELERO_PRIMARY and this version.
 */
export const VELERO_OLDEST_SUPPORTED = '1.16.2';

/** Minor versions the control plane and agent accept, newest first. */
export const SUPPORTED_VELERO_MINORS = ['1.18', '1.17', '1.16'] as const;

export type SupportedVeleroMinor = (typeof SUPPORTED_VELERO_MINORS)[number];

/**
 * Go module path for the Velero API types.
 *
 * The GitHub repository moved to github.com/velero-io/velero (requests to
 * vmware-tanzu/velero are redirected), but the module path declared in
 * go.mod at v1.18.4 is still github.com/vmware-tanzu/velero. Imports must use
 * the declared path. See docs/DECISIONS.md ADR-002.
 */
export const VELERO_GO_MODULE = 'github.com/vmware-tanzu/velero';

/** Canonical source repository, for documentation links. */
export const VELERO_REPO_URL = 'https://github.com/velero-io/velero';

/**
 * Extracts the `major.minor` prefix of a Velero version string.
 *
 * The patch component must be numeric when present, so a wildcard such as
 * `1.18.x` is rejected rather than silently read as 1.18 — the capability map
 * keys off this value and a range is not a version.
 */
export function veleroMinorOf(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(version.trim());
  const [, major, minor] = match ?? [];
  if (major === undefined || minor === undefined) {
    return null;
  }
  return `${major}.${minor}`;
}

/**
 * Whether a Velero server version reported by an agent falls inside the
 * supported window. Unparseable versions are treated as unsupported so the UI
 * degrades to read-only rather than guessing at capabilities.
 */
export function isSupportedVeleroVersion(version: string): boolean {
  const minor = veleroMinorOf(version);
  if (minor === null) {
    return false;
  }
  return (SUPPORTED_VELERO_MINORS as readonly string[]).includes(minor);
}

/**
 * How this UI build relates to a cluster's Velero server (SOW FR-20).
 *
 * - `supported`: inside the tested window.
 * - `warn`: newer than the pinned primary; untested, commands still run.
 * - `blocked`: older than the window, or a version we cannot read; commands are refused.
 * - `unknown`: the agent has not reported a version yet.
 */
export type VeleroCompatibility = 'supported' | 'warn' | 'blocked' | 'unknown';

export function veleroCompatibility(version: string | null): VeleroCompatibility {
  if (version === null || version === '') {
    return 'unknown';
  }
  const minor = veleroMinorOf(version);
  if (minor === null) {
    return 'blocked';
  }
  if (isSupportedVeleroVersion(version)) {
    return 'supported';
  }
  const [maj = 0, min = 0] = minor.split('.').map(Number);
  const [pMaj = 0, pMin = 0] = (veleroMinorOf(VELERO_PRIMARY) ?? '0.0').split('.').map(Number);
  return maj > pMaj || (maj === pMaj && min > pMin) ? 'warn' : 'blocked';
}

/** The declared matrix, for display: the UI build and the Velero minors it is tested with. */
export const VELERO_COMPATIBILITY_MATRIX = {
  tested: SUPPORTED_VELERO_MINORS,
  primary: VELERO_PRIMARY,
  oldest: VELERO_OLDEST_SUPPORTED,
} as const;
