import { BUILT_IN_ROLES, CLUSTER_ROLES, PERMISSIONS, isNamespaced } from '@vfm/shared';

/**
 * Renders the generated reference documents. Pure, so a test can prove the committed files are
 * exactly what the code says today (a reference that drifts from the code is worse than none).
 * `pnpm --filter @vfm/server run gen:docs` rewrites them.
 */

interface Operation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  responses?: Record<string, { description?: string }>;
}
export interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const cell = (text: string): string => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

export function renderApi(doc: OpenApiDocument): string {
  const groups = new Map<string, { method: string; path: string; op: Operation }[]>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (op === undefined) continue;
      const tag = op.tags?.[0] ?? 'other';
      const list = groups.get(tag) ?? [];
      list.push({ method: method.toUpperCase(), path, op });
      groups.set(tag, list);
    }
  }
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  const lines = [
    '# REST API reference',
    '',
    '_Generated from `server/openapi.yaml` by `pnpm --filter @vfm/server run gen:docs`. Do not edit by hand: a test fails when it drifts._',
    '',
    `All paths are under \`/api/v1\`. ${String(total)} operations. Authentication is a session cookie (browser) or a \`Bearer vfm_...\``,
    'API token; every state-changing request also needs the `X-CSRF-Token` header (sessions) and a recent',
    're-authentication ("sudo") where the operation is marked as needing one. Errors are RFC 9457',
    '`application/problem+json`. Lists use cursor pagination (`limit` up to 200, `cursor`). The machine-readable',
    'contract is `server/openapi.yaml` (OpenAPI 3.1).',
    '',
  ];
  for (const [tag, ops] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `## ${tag}`,
      '',
      '| Method | Path | What it does | Responses |',
      '| --- | --- | --- | --- |',
    );
    for (const { method, path, op } of ops) {
      const codes = Object.keys(op.responses ?? {}).join(', ');
      lines.push(
        `| ${method} | \`${path}\` | ${cell(op.summary ?? op.operationId ?? '')} | ${codes} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

const ROLE_LABEL: Record<(typeof CLUSTER_ROLES)[number], string> = {
  VIEWER: 'Viewer',
  OPERATOR: 'Operator',
  RESTORER: 'Restorer',
  CLUSTER_ADMIN: 'Cluster Admin',
};

export function renderRbac(): string {
  const lines = [
    '# RBAC reference',
    '',
    '_Generated from `packages/shared/src/rbac.ts` by `pnpm --filter @vfm/server run gen:docs`. Do not edit by hand: a test fails when it drifts._',
    '',
    '## Roles and permissions (PLAN section 8.2)',
    '',
    `| Permission | Scope | ${CLUSTER_ROLES.map((r) => ROLE_LABEL[r]).join(' | ')} |`,
    `| --- | --- | ${CLUSTER_ROLES.map(() => ':---:').join(' | ')} |`,
  ];
  for (const permission of PERMISSIONS) {
    const marks = CLUSTER_ROLES.map((r) => (BUILT_IN_ROLES[r].includes(permission) ? 'yes' : '-'));
    lines.push(
      `| \`${permission}\` | ${isNamespaced(permission) ? 'namespace' : 'cluster'} | ${marks.join(' | ')} |`,
    );
  }
  lines.push(
    '',
    '## How a decision is made',
    '',
    '* **Deny by default, and on doubt.** A permission exists only where a binding positively grants it.',
    '* A binding gives a **role** to a **user or a team** on **one cluster**, with a scope: the whole cluster,',
    '  a list of namespaces, or a label selector (a selector denies until namespace labels are synced).',
    '* **Namespaced permissions** (`namespace` above) are checked against every namespace a request touches.',
    '  A request is allowed only if **all** of them are in scope: for a restore, both the source and the',
    '  mapped target namespace. A request that includes cluster-scoped resources, or a wildcard, needs a',
    '  whole-cluster binding.',
    '* A namespace-scoped binding still carries `cluster:read` and `storage:read`, so the person can see the',
    '  cluster exists and where it backs up to, and nothing about other namespaces.',
    '* **Organization Owners and Admins** are implicitly Cluster Admin on every cluster of the organization.',
    '  The **platform admin** administers organizations, not their clusters.',
    '* A cluster you may not see is `404`; one you can see but may not act on is `403`.',
    '* **Sudo mode**: restore create, any delete, storage writes, cluster deletion and role-binding changes also',
    '  need a re-authentication within the last 5 minutes.',
    "* **API tokens** can only narrow: a token holds a subset of its owner's permissions and clusters, never more.",
    '* The cluster owner can narrow further with the **agent policy** (`readOnly`, denied namespaces, no',
    '  BSL writes, no log streaming); the control plane cannot widen it.',
    '',
  );
  return lines.join('\n');
}
