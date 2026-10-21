/**
 * Role-based access control (PLAN.md §8.2).
 *
 * Everything here is pure: data in, decision out, no I/O. That keeps the most
 * security-critical function in the codebase testable exhaustively and lets the
 * web app reuse the same decision for hiding controls (never for enforcing
 * them — the server always re-checks).
 *
 * ## Posture
 *
 * **Deny by default and on doubt.** A permission is granted only when a binding
 * positively says so. Unknown roles, unknown permissions, malformed scopes,
 * missing namespace information and unknown namespace labels all deny.
 */

/** Every permission in PLAN.md §8.2. */
export const PERMISSIONS = [
  'cluster:read',
  'backup:read',
  'restore:read',
  'schedule:read',
  'storage:read',
  'backup:logs',
  'restore:logs',
  'logs:read',
  'backup:create',
  'schedule:write',
  'restore:create',
  'backup:delete',
  'restore:delete',
  'schedule:delete',
  'storage:write',
  'backup:download',
  'advanced:write',
  'cluster:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const CLUSTER_ROLES = ['VIEWER', 'OPERATOR', 'RESTORER', 'CLUSTER_ADMIN'] as const;
export type ClusterRole = (typeof CLUSTER_ROLES)[number];

/** Role names used by the SOW (HLRD §7); the enum values stay stable for stored bindings. */
export const CLUSTER_ROLE_LABELS: Readonly<Record<ClusterRole, string>> = {
  VIEWER: 'Read-only Auditor',
  OPERATOR: 'Backup Operator',
  RESTORER: 'Restore Operator',
  CLUSTER_ADMIN: 'Platform Administrator',
};

const VIEWER: readonly Permission[] = [
  'cluster:read',
  'backup:read',
  'restore:read',
  'schedule:read',
  'storage:read',
];

const OPERATOR: readonly Permission[] = [
  ...VIEWER,
  'backup:logs',
  'restore:logs',
  'logs:read',
  'backup:create',
  'schedule:write',
];

const RESTORER: readonly Permission[] = [
  ...VIEWER,
  'backup:logs',
  'restore:logs',
  'logs:read',
  'backup:create',
  'restore:create',
];

/**
 * Built-in roles **as data**, not code (§8.2: "store roles as data (a
 * permission array)"). Custom roles in v1.1 add rows to the same shape.
 */
export const BUILT_IN_ROLES: Readonly<Record<ClusterRole, readonly Permission[]>> = {
  VIEWER,
  OPERATOR,
  RESTORER,
  CLUSTER_ADMIN: [...PERMISSIONS],
};

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

export function isClusterRole(value: unknown): value is ClusterRole {
  return typeof value === 'string' && (CLUSTER_ROLES as readonly string[]).includes(value);
}

/**
 * Permissions that act on a particular namespace's resources. Everything else
 * is cluster-level.
 */
const NAMESPACED: ReadonlySet<Permission> = new Set<Permission>([
  'backup:read',
  'restore:read',
  'schedule:read',
  'backup:logs',
  'restore:logs',
  'logs:read',
  'backup:create',
  'schedule:write',
  'restore:create',
  'backup:delete',
  'restore:delete',
  'schedule:delete',
  'backup:download',
]);

/**
 * Cluster-level permissions a *scoped* binding may still carry: seeing that a
 * cluster exists and what storage it is wired to. They expose no namespace's
 * data, and a scoped user needs them to use the product at all.
 */
const CLUSTER_READ: ReadonlySet<Permission> = new Set<Permission>(['cluster:read', 'storage:read']);

/** Whether `permission` is checked against namespaces. */
export function isNamespaced(permission: Permission): boolean {
  return NAMESPACED.has(permission);
}

export type BindingScope =
  | { readonly type: 'CLUSTER' }
  | { readonly type: 'NAMESPACES'; readonly namespaces: readonly string[] }
  | {
      readonly type: 'SELECTOR';
      readonly selector: { readonly matchLabels: Readonly<Record<string, string>> };
    };

export interface RoleBinding {
  readonly clusterId: string;
  readonly subjectType: 'USER' | 'TEAM';
  readonly subjectId: string;
  /** A {@link ClusterRole} key; typed loosely because it comes from the database. */
  readonly role: string;
  /** Typed loosely for the same reason; validated by {@link normaliseScope}. */
  readonly scope: unknown;
}

export interface Principal {
  readonly userId: string;
  /** `undefined` when the user is not a member of the org. Denies everything. */
  readonly orgRole: 'OWNER' | 'ADMIN' | 'MEMBER' | undefined;
  readonly teamIds: readonly string[];
  /**
   * Set when the caller is an API token. The token can only *narrow* what its
   * owner holds: `null` for a field means "no extra limit", not "everything".
   */
  readonly tokenLimit?: {
    readonly permissions: readonly string[] | null;
    readonly clusterIds: readonly string[] | null;
  };
}

export interface AuthorizeRequest {
  readonly clusterId: string;
  readonly permission: string;
  /**
   * The namespaces the operation touches, **after** namespace mapping for a
   * restore (see {@link restoreNamespaces}). Required for namespaced
   * permissions on a scoped binding. `[]` and any `'*'` mean "all namespaces".
   */
  readonly namespaces?: readonly string[];
  /** Whether the operation includes cluster-scoped resources. */
  readonly includesClusterScoped?: boolean;
  /**
   * Labels per namespace, needed only to evaluate SELECTOR scopes. Until the
   * inventory supplies them (M3) a selector binding grants nothing.
   */
  readonly namespaceLabels?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface AuthorizeContext {
  /** The org setting gating `backup:download` (§8.2, "and org setting on"). */
  readonly allowBackupContentDownload?: boolean;
}

export type DenyReason =
  | 'unknown-permission'
  | 'not-a-member'
  | 'token-limit'
  | 'no-binding'
  | 'download-disabled'
  | 'namespaces-required'
  | 'wildcard-needs-cluster-scope'
  | 'cluster-scoped-needs-cluster-scope'
  | 'cluster-level-needs-cluster-scope'
  | 'namespace-out-of-scope';

export type Decision =
  | { readonly allowed: true; readonly via: 'org-role' | 'binding' }
  | { readonly allowed: false; readonly reason: DenyReason };

const DENY = (reason: DenyReason): Decision => ({ allowed: false, reason });

/** A namespace name as Kubernetes defines it (RFC 1123 label). */
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validates a stored scope, returning `null` for anything malformed so the
 * caller denies. A binding whose scope cannot be read must never widen.
 */
export function normaliseScope(raw: unknown): BindingScope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const scope = raw as Record<string, unknown>;

  if (scope.type === 'CLUSTER') {
    return { type: 'CLUSTER' };
  }

  if (scope.type === 'NAMESPACES') {
    const list = scope.namespaces;
    if (!Array.isArray(list) || list.length === 0) {
      return null;
    }
    // A wildcard or malformed name in a scoped binding is a configuration
    // error, not a request for "everything".
    if (!list.every((n): n is string => typeof n === 'string' && NAMESPACE.test(n))) {
      return null;
    }
    return { type: 'NAMESPACES', namespaces: [...new Set(list)] };
  }

  if (scope.type === 'SELECTOR') {
    const selector = scope.selector;
    if (typeof selector !== 'object' || selector === null) {
      return null;
    }
    const match = (selector as Record<string, unknown>).matchLabels;
    if (typeof match !== 'object' || match === null || Array.isArray(match)) {
      return null;
    }
    const entries = Object.entries(match);
    // An empty selector selects everything in Kubernetes; here it is refused
    // so a half-filled form cannot silently become a whole-cluster grant.
    if (entries.length === 0 || !entries.every(([, v]) => typeof v === 'string')) {
      return null;
    }
    return {
      type: 'SELECTOR',
      selector: { matchLabels: Object.fromEntries(entries) },
    };
  }

  return null;
}

/** Whether the request means "all namespaces" rather than a concrete list. */
function isWildcard(namespaces: readonly string[]): boolean {
  return namespaces.length === 0 || namespaces.some((n) => n === '*' || n === '');
}

function inScope(
  scope: Exclude<BindingScope, { type: 'CLUSTER' }>,
  namespace: string,
  labels: AuthorizeRequest['namespaceLabels'],
): boolean {
  if (scope.type === 'NAMESPACES') {
    return scope.namespaces.includes(namespace);
  }
  const actual = labels?.[namespace];
  if (actual === undefined) {
    return false;
  }
  return Object.entries(scope.selector.matchLabels).every(
    ([key, value]) => Object.hasOwn(actual, key) && actual[key] === value,
  );
}

/**
 * Decides whether `principal` may perform `request.permission` on a cluster.
 *
 * `bindings` should already be limited to the org; clusters other than
 * `request.clusterId` are ignored here as a second line of defence.
 *
 * ## Rules (PLAN.md §8.2)
 *
 *  1. Org Owner and Admin are implicitly Cluster Admin on every cluster.
 *  2. Otherwise a binding grants a permission when its role includes it and its
 *     subject is the user or one of the user's teams. Grants from several
 *     bindings add up.
 *  3. A **whole-cluster** binding grants the permission everywhere, wildcards
 *     and cluster-scoped resources included.
 *  4. A **scoped** binding grants a namespaced permission only if *every*
 *     requested namespace is in scope — by some binding that carries the
 *     permission — the request names its namespaces, uses no wildcard and
 *     includes no cluster-scoped resources.
 *  5. Cluster-level permissions that change the cluster (`storage:write`,
 *     `advanced:write`, `cluster:manage`) need a whole-cluster binding.
 *  6. `backup:download` additionally needs the org setting on, for everyone.
 */
export function authorize(
  principal: Principal,
  request: AuthorizeRequest,
  bindings: readonly RoleBinding[],
  context: AuthorizeContext = {},
): Decision {
  if (!isPermission(request.permission)) {
    return DENY('unknown-permission');
  }
  const permission = request.permission;

  if (principal.orgRole === undefined) {
    return DENY('not-a-member');
  }

  if (exceedsTokenLimit(principal, request.clusterId, permission)) {
    return DENY('token-limit');
  }

  if (permission === 'backup:download' && context.allowBackupContentDownload !== true) {
    return DENY('download-disabled');
  }

  if (principal.orgRole === 'OWNER' || principal.orgRole === 'ADMIN') {
    return { allowed: true, via: 'org-role' };
  }

  const teams = new Set(principal.teamIds);
  const applicable: { scope: BindingScope }[] = [];

  for (const binding of bindings) {
    if (binding.clusterId !== request.clusterId) {
      continue;
    }
    const mine =
      binding.subjectType === 'USER'
        ? binding.subjectId === principal.userId
        : teams.has(binding.subjectId);
    if (!mine || !isClusterRole(binding.role)) {
      continue;
    }
    if (!BUILT_IN_ROLES[binding.role].includes(permission)) {
      continue;
    }
    const scope = normaliseScope(binding.scope);
    if (scope !== null) {
      applicable.push({ scope });
    }
  }

  if (applicable.length === 0) {
    return DENY('no-binding');
  }

  if (applicable.some((b) => b.scope.type === 'CLUSTER')) {
    return { allowed: true, via: 'binding' };
  }

  // Only scoped bindings grant this permission from here on.
  if (CLUSTER_READ.has(permission)) {
    return { allowed: true, via: 'binding' };
  }
  if (!isNamespaced(permission)) {
    return DENY('cluster-level-needs-cluster-scope');
  }
  if (request.includesClusterScoped === true) {
    return DENY('cluster-scoped-needs-cluster-scope');
  }
  const namespaces = request.namespaces;
  if (namespaces === undefined) {
    return DENY('namespaces-required');
  }
  if (isWildcard(namespaces)) {
    return DENY('wildcard-needs-cluster-scope');
  }

  const scopes = applicable.map((b) => b.scope).filter((s) => s.type !== 'CLUSTER');
  const everyCovered = namespaces.every((ns) =>
    scopes.some((scope) => inScope(scope, ns, request.namespaceLabels)),
  );
  return everyCovered ? { allowed: true, via: 'binding' } : DENY('namespace-out-of-scope');
}

/**
 * Whether any rule at all could grant `permission` on the cluster, ignoring
 * namespaces. This answers "may this user even try?" so a route guard can let a
 * scoped user through to a handler that then calls {@link authorize} with the
 * request's real namespaces. It is **never** sufficient on its own for a
 * namespaced permission.
 */
function exceedsTokenLimit(principal: Principal, clusterId: string, permission: string): boolean {
  const limit = principal.tokenLimit;
  if (limit === undefined) {
    return false;
  }
  return (
    (limit.clusterIds !== null && !limit.clusterIds.includes(clusterId)) ||
    (limit.permissions !== null && !limit.permissions.includes(permission))
  );
}

export function mayAttempt(
  principal: Principal,
  clusterId: string,
  permission: string,
  bindings: readonly RoleBinding[],
  context: AuthorizeContext = {},
): boolean {
  if (!isPermission(permission) || principal.orgRole === undefined) {
    return false;
  }
  if (exceedsTokenLimit(principal, clusterId, permission)) {
    return false;
  }
  if (permission === 'backup:download' && context.allowBackupContentDownload !== true) {
    return false;
  }
  if (principal.orgRole === 'OWNER' || principal.orgRole === 'ADMIN') {
    return true;
  }
  const teams = new Set(principal.teamIds);
  return bindings.some((b) => {
    const mine =
      b.subjectType === 'USER' ? b.subjectId === principal.userId : teams.has(b.subjectId);
    return (
      b.clusterId === clusterId &&
      mine &&
      isClusterRole(b.role) &&
      BUILT_IN_ROLES[b.role].includes(permission) &&
      normaliseScope(b.scope) !== null
    );
  });
}

/**
 * The namespaces a restore touches: every namespace read from the backup *and*
 * every namespace written to after mapping.
 *
 * Both sides count. Checking only the target would let a user scoped to `dev`
 * restore `prod`'s data into `dev` and read it there.
 */
export function restoreNamespaces(
  included: readonly string[],
  mapping: Readonly<Record<string, string>> = {},
): string[] {
  const all = new Set<string>();
  for (const source of included) {
    all.add(source);
    // Object.hasOwn: a source named "constructor" must not hit the prototype.
    const target = Object.hasOwn(mapping, source) ? mapping[source] : undefined;
    if (target !== undefined) {
      all.add(target);
    }
  }
  return [...all];
}

/**
 * Which namespaces' resources `principal` may *list* for `permission`, so list
 * endpoints can filter instead of failing. `'all'` means no filter;
 * `[]` means nothing is visible. `knownNamespaces` is what the inventory has
 * reported; a namespace not yet reported is not listed, which is the safe
 * direction. SELECTOR bindings contribute nothing until labels are supplied.
 */
export function visibleNamespaces(
  principal: Principal,
  clusterId: string,
  permission: Permission,
  bindings: readonly RoleBinding[],
  context: AuthorizeContext = {},
  namespaceLabels?: AuthorizeRequest['namespaceLabels'],
  knownNamespaces: readonly string[] = [],
): 'all' | string[] {
  const whole = authorize(principal, { clusterId, permission, namespaces: [] }, bindings, context);
  if (whole.allowed) {
    return 'all';
  }
  // Reasons that no namespace list can repair: nothing is visible.
  if (whole.reason !== 'wildcard-needs-cluster-scope' && whole.reason !== 'namespaces-required') {
    return [];
  }
  return knownNamespaces.filter(
    (namespace) =>
      authorize(
        principal,
        {
          clusterId,
          permission,
          namespaces: [namespace],
          ...(namespaceLabels === undefined ? {} : { namespaceLabels }),
        },
        bindings,
        context,
      ).allowed,
  );
}

/** Cluster environment types offered in the inventory (SOW FR-02). */
export const ENVIRONMENT_TYPES = ['production', 'staging', 'development', 'dr', 'other'] as const;
