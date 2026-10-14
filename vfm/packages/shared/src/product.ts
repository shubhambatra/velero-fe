/**
 * Every user-visible mention of the product name resolves here.
 *
 * PLAN.md §0 requires the working name to live in exactly one constant per
 * package so renaming the product is a one-line change. Do not hard-code
 * "Velero Fleet Manager" or "VFM" anywhere else in TypeScript — import these.
 *
 * The Go agent keeps its own equivalent in agent/internal/config.
 */

/** Full product name, for page titles, emails and documentation headings. */
export const PRODUCT_NAME = 'Velero Fleet Manager';

/** Short name, for compact UI (nav bar, breadcrumbs, log fields). */
export const PRODUCT_SHORT_NAME = 'VFM';

/**
 * Slug used in technical identifiers that are awkward to change later:
 * Kubernetes namespace (`vfm-system`), API-token prefix (`vfm_`),
 * CR label/annotation domain (`vfm.io/...`) and metric prefixes.
 *
 * Renaming the product does NOT require renaming this — doing so is a
 * breaking change for already-enrolled clusters.
 */
export const PRODUCT_SLUG = 'vfm';

/** Kubernetes namespace the agent installs into (PLAN.md §3). */
export const AGENT_NAMESPACE = `${PRODUCT_SLUG}-system`;

/** Label/annotation domain applied to every CR the agent creates (PLAN.md §5.4). */
export const RESOURCE_DOMAIN = `${PRODUCT_SLUG}.io`;

/** Prefix of generated API tokens (PLAN.md §8.3). */
export const API_TOKEN_PREFIX = `${PRODUCT_SLUG}_`;
