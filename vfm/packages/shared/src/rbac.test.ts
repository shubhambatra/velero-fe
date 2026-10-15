import { describe, expect, it } from 'vitest';

import {
  authorize,
  BUILT_IN_ROLES,
  CLUSTER_ROLES,
  normaliseScope,
  PERMISSIONS,
  mayAttempt,
  restoreNamespaces,
  visibleNamespaces,
  type AuthorizeContext,
  type AuthorizeRequest,
  type DenyReason,
  type Principal,
  type RoleBinding,
} from './rbac.js';

const C1 = 'cluster-1';
const C2 = 'cluster-2';
const ALICE = 'user-alice';
const TEAM = 'team-sre';

const member = (teamIds: string[] = []): Principal => ({
  userId: ALICE,
  orgRole: 'MEMBER',
  teamIds,
});

const bind = (role: string, scope: unknown, over: Partial<RoleBinding> = {}): RoleBinding => ({
  clusterId: C1,
  subjectType: 'USER',
  subjectId: ALICE,
  role,
  scope,
  ...over,
});

const WHOLE = { type: 'CLUSTER' };
const ns = (...namespaces: string[]) => ({ type: 'NAMESPACES', namespaces });

interface Case {
  name: string;
  principal?: Principal;
  bindings: RoleBinding[];
  request: Partial<AuthorizeRequest> & { permission: string };
  context?: AuthorizeContext;
  expect: 'allow' | DenyReason;
}

function run(c: Case) {
  return authorize(c.principal ?? member(), { clusterId: C1, ...c.request }, c.bindings, c.context);
}

const CASES: Case[] = [
  // --- deny by default -----------------------------------------------------
  {
    name: 'no bindings at all',
    bindings: [],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'unknown permission',
    bindings: [bind('CLUSTER_ADMIN', WHOLE)],
    request: { permission: 'cluster:destroy' },
    expect: 'unknown-permission',
  },
  {
    name: 'empty permission string',
    bindings: [bind('CLUSTER_ADMIN', WHOLE)],
    request: { permission: '' },
    expect: 'unknown-permission',
  },
  {
    name: 'prototype key as permission',
    bindings: [bind('CLUSTER_ADMIN', WHOLE)],
    request: { permission: 'constructor' },
    expect: 'unknown-permission',
  },
  {
    name: 'non-member with a surviving binding',
    principal: { userId: ALICE, orgRole: undefined, teamIds: [] },
    bindings: [bind('CLUSTER_ADMIN', WHOLE)],
    request: { permission: 'cluster:read' },
    expect: 'not-a-member',
  },
  {
    name: 'unknown role in a binding',
    bindings: [bind('SUPERUSER', WHOLE)],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'binding on another cluster',
    bindings: [bind('CLUSTER_ADMIN', WHOLE, { clusterId: C2 })],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'binding for another user',
    bindings: [bind('CLUSTER_ADMIN', WHOLE, { subjectId: 'user-bob' })],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'team binding when not in the team',
    bindings: [bind('CLUSTER_ADMIN', WHOLE, { subjectType: 'TEAM', subjectId: TEAM })],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'USER binding whose subject id equals a team id',
    bindings: [bind('CLUSTER_ADMIN', WHOLE, { subjectType: 'USER', subjectId: TEAM })],
    principal: member([TEAM]),
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'TEAM binding whose subject id equals the user id',
    bindings: [bind('CLUSTER_ADMIN', WHOLE, { subjectType: 'TEAM', subjectId: ALICE })],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'malformed scope (null)',
    bindings: [bind('CLUSTER_ADMIN', null)],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'malformed scope (unknown type)',
    bindings: [bind('CLUSTER_ADMIN', { type: 'ALL' })],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'malformed scope (string)',
    bindings: [bind('CLUSTER_ADMIN', 'CLUSTER')],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },

  // --- built-in roles, whole cluster --------------------------------------
  {
    name: 'viewer reads backups',
    bindings: [bind('VIEWER', WHOLE)],
    request: { permission: 'backup:read', namespaces: [] },
    expect: 'allow',
  },
  {
    name: 'viewer cannot read backup logs',
    bindings: [bind('VIEWER', WHOLE)],
    request: { permission: 'backup:logs', namespaces: [] },
    expect: 'no-binding',
  },
  {
    name: 'viewer cannot create backups',
    bindings: [bind('VIEWER', WHOLE)],
    request: { permission: 'backup:create' },
    expect: 'no-binding',
  },
  {
    name: 'operator creates backups',
    bindings: [bind('OPERATOR', WHOLE)],
    request: { permission: 'backup:create' },
    expect: 'allow',
  },
  {
    name: 'operator writes schedules',
    bindings: [bind('OPERATOR', WHOLE)],
    request: { permission: 'schedule:write' },
    expect: 'allow',
  },
  {
    name: 'operator cannot restore',
    bindings: [bind('OPERATOR', WHOLE)],
    request: { permission: 'restore:create' },
    expect: 'no-binding',
  },
  {
    name: 'operator cannot delete backups',
    bindings: [bind('OPERATOR', WHOLE)],
    request: { permission: 'backup:delete' },
    expect: 'no-binding',
  },
  {
    name: 'restorer restores',
    bindings: [bind('RESTORER', WHOLE)],
    request: { permission: 'restore:create' },
    expect: 'allow',
  },
  {
    name: 'restorer creates backups',
    bindings: [bind('RESTORER', WHOLE)],
    request: { permission: 'backup:create' },
    expect: 'allow',
  },
  {
    name: 'restorer cannot write schedules',
    bindings: [bind('RESTORER', WHOLE)],
    request: { permission: 'schedule:write' },
    expect: 'no-binding',
  },
  {
    name: 'restorer cannot write storage',
    bindings: [bind('RESTORER', WHOLE)],
    request: { permission: 'storage:write' },
    expect: 'no-binding',
  },
  {
    name: 'cluster admin deletes backups',
    bindings: [bind('CLUSTER_ADMIN', WHOLE)],
    request: { permission: 'backup:delete' },
    expect: 'allow',
  },
  {
    name: 'cluster admin writes storage',
    bindings: [bind('CLUSTER_ADMIN', WHOLE)],
    request: { permission: 'storage:write' },
    expect: 'allow',
  },
  {
    name: 'cluster admin manages the cluster',
    bindings: [bind('CLUSTER_ADMIN', WHOLE)],
    request: { permission: 'cluster:manage' },
    expect: 'allow',
  },

  // --- backup:download needs the org setting -------------------------------
  {
    name: 'download with setting off',
    bindings: [bind('CLUSTER_ADMIN', WHOLE)],
    request: { permission: 'backup:download', namespaces: [] },
    expect: 'download-disabled',
  },
  {
    name: 'download with setting on',
    bindings: [bind('CLUSTER_ADMIN', WHOLE)],
    request: { permission: 'backup:download', namespaces: [] },
    context: { allowBackupContentDownload: true },
    expect: 'allow',
  },
  {
    name: 'download with setting on but role lacks it',
    bindings: [bind('OPERATOR', WHOLE)],
    request: { permission: 'backup:download', namespaces: [] },
    context: { allowBackupContentDownload: true },
    expect: 'no-binding',
  },
  {
    name: 'org owner is also gated by the download setting',
    principal: { userId: ALICE, orgRole: 'OWNER', teamIds: [] },
    bindings: [],
    request: { permission: 'backup:download' },
    expect: 'download-disabled',
  },
  {
    name: 'org owner downloads with setting on',
    principal: { userId: ALICE, orgRole: 'OWNER', teamIds: [] },
    bindings: [],
    request: { permission: 'backup:download' },
    context: { allowBackupContentDownload: true },
    expect: 'allow',
  },

  // --- org roles ------------------------------------------------------------
  {
    name: 'org owner is implicit cluster admin',
    principal: { userId: ALICE, orgRole: 'OWNER', teamIds: [] },
    bindings: [],
    request: { permission: 'cluster:manage' },
    expect: 'allow',
  },
  {
    name: 'org admin is implicit cluster admin',
    principal: { userId: ALICE, orgRole: 'ADMIN', teamIds: [] },
    bindings: [],
    request: { permission: 'restore:create', namespaces: ['*'], includesClusterScoped: true },
    expect: 'allow',
  },
  {
    name: 'org member has nothing implicit',
    bindings: [],
    request: { permission: 'cluster:read' },
    expect: 'no-binding',
  },
  {
    name: 'org admin gets no pass on unknown permissions',
    principal: { userId: ALICE, orgRole: 'ADMIN', teamIds: [] },
    bindings: [],
    request: { permission: 'nope' },
    expect: 'unknown-permission',
  },

  // --- team inheritance ------------------------------------------------------
  {
    name: 'team binding grants a member of the team',
    principal: member([TEAM]),
    bindings: [bind('OPERATOR', WHOLE, { subjectType: 'TEAM', subjectId: TEAM })],
    request: { permission: 'backup:create' },
    expect: 'allow',
  },
  {
    name: 'team grant is limited to the team role',
    principal: member([TEAM]),
    bindings: [bind('OPERATOR', WHOLE, { subjectType: 'TEAM', subjectId: TEAM })],
    request: { permission: 'restore:create' },
    expect: 'no-binding',
  },
  {
    name: 'user and team bindings add up',
    principal: member([TEAM]),
    bindings: [
      bind('OPERATOR', WHOLE, { subjectType: 'TEAM', subjectId: TEAM }),
      bind('RESTORER', WHOLE),
    ],
    request: { permission: 'restore:create' },
    expect: 'allow',
  },
  {
    name: 'several teams, only one matches',
    principal: member(['t-a', TEAM]),
    bindings: [bind('VIEWER', WHOLE, { subjectType: 'TEAM', subjectId: TEAM })],
    request: { permission: 'cluster:read' },
    expect: 'allow',
  },
  {
    name: 'scoped team binding is namespace limited',
    principal: member([TEAM]),
    bindings: [bind('OPERATOR', ns('dev'), { subjectType: 'TEAM', subjectId: TEAM })],
    request: { permission: 'backup:create', namespaces: ['prod'] },
    expect: 'namespace-out-of-scope',
  },

  // --- namespace scoping (the security-critical rule, §8.2) ---------------
  {
    name: 'scoped: one namespace in scope',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['dev'] },
    expect: 'allow',
  },
  {
    name: 'scoped: all namespaces in scope',
    bindings: [bind('OPERATOR', ns('dev', 'stage'))],
    request: { permission: 'backup:create', namespaces: ['dev', 'stage'] },
    expect: 'allow',
  },
  {
    name: 'scoped: one of two out of scope',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['dev', 'prod'] },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'scoped: namespace out of scope',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['prod'] },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'scoped: prefix is not a match',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['dev-2'] },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'scoped: case is significant',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['Dev'] },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'scoped: wildcard denied',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['*'] },
    expect: 'wildcard-needs-cluster-scope',
  },
  {
    name: 'scoped: wildcard mixed with a real namespace denied',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['dev', '*'] },
    expect: 'wildcard-needs-cluster-scope',
  },
  {
    name: 'scoped: empty list means all namespaces, denied',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: [] },
    expect: 'wildcard-needs-cluster-scope',
  },
  {
    name: 'scoped: empty string namespace denied',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: [''] },
    expect: 'wildcard-needs-cluster-scope',
  },
  {
    name: 'scoped: namespaces not stated is denied',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create' },
    expect: 'namespaces-required',
  },
  {
    name: 'scoped: cluster-scoped resources denied',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['dev'], includesClusterScoped: true },
    expect: 'cluster-scoped-needs-cluster-scope',
  },
  {
    name: 'scoped: cluster-scoped resources false is fine',
    bindings: [bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['dev'], includesClusterScoped: false },
    expect: 'allow',
  },
  {
    name: 'scoped: restore needs source and target',
    bindings: [bind('RESTORER', ns('dev'))],
    request: {
      permission: 'restore:create',
      namespaces: restoreNamespaces(['prod'], { prod: 'dev' }),
    },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'scoped: restore mapped within scope',
    bindings: [bind('RESTORER', ns('dev', 'dev-copy'))],
    request: {
      permission: 'restore:create',
      namespaces: restoreNamespaces(['dev'], { dev: 'dev-copy' }),
    },
    expect: 'allow',
  },
  {
    name: 'scoped: restore mapped out of scope',
    bindings: [bind('RESTORER', ns('dev'))],
    request: {
      permission: 'restore:create',
      namespaces: restoreNamespaces(['dev'], { dev: 'prod' }),
    },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'scoped: restore with cluster resources',
    bindings: [bind('RESTORER', ns('dev'))],
    request: { permission: 'restore:create', namespaces: ['dev'], includesClusterScoped: true },
    expect: 'cluster-scoped-needs-cluster-scope',
  },
  {
    name: 'scoped: storage:write needs whole cluster',
    bindings: [bind('CLUSTER_ADMIN', ns('dev'))],
    request: { permission: 'storage:write', namespaces: ['dev'] },
    expect: 'cluster-level-needs-cluster-scope',
  },
  {
    name: 'scoped: cluster:manage needs whole cluster',
    bindings: [bind('CLUSTER_ADMIN', ns('dev'))],
    request: { permission: 'cluster:manage' },
    expect: 'cluster-level-needs-cluster-scope',
  },
  {
    name: 'scoped: advanced:write needs whole cluster',
    bindings: [bind('CLUSTER_ADMIN', ns('dev'))],
    request: { permission: 'advanced:write' },
    expect: 'cluster-level-needs-cluster-scope',
  },
  {
    name: 'scoped: cluster:read allowed',
    bindings: [bind('VIEWER', ns('dev'))],
    request: { permission: 'cluster:read' },
    expect: 'allow',
  },
  {
    name: 'scoped: storage:read allowed',
    bindings: [bind('VIEWER', ns('dev'))],
    request: { permission: 'storage:read' },
    expect: 'allow',
  },
  {
    name: 'scoped: scoped delete in scope',
    bindings: [bind('CLUSTER_ADMIN', ns('dev'))],
    request: { permission: 'backup:delete', namespaces: ['dev'] },
    expect: 'allow',
  },
  {
    name: 'scoped: scoped delete out of scope',
    bindings: [bind('CLUSTER_ADMIN', ns('dev'))],
    request: { permission: 'backup:delete', namespaces: ['prod'] },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'scoped: namespaces covered by two bindings',
    bindings: [bind('OPERATOR', ns('dev')), bind('OPERATOR', ns('stage'))],
    request: { permission: 'backup:create', namespaces: ['dev', 'stage'] },
    expect: 'allow',
  },
  {
    name: 'scoped: a binding without the permission does not cover',
    bindings: [bind('OPERATOR', ns('dev')), bind('VIEWER', ns('stage'))],
    request: { permission: 'backup:create', namespaces: ['dev', 'stage'] },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'scoped: invalid namespace name in the binding grants nothing',
    bindings: [bind('OPERATOR', ns('dev', '*'))],
    request: { permission: 'backup:create', namespaces: ['dev'] },
    expect: 'no-binding',
  },
  {
    name: 'scoped: empty namespace list in the binding grants nothing',
    bindings: [bind('OPERATOR', ns())],
    request: { permission: 'backup:create', namespaces: ['dev'] },
    expect: 'no-binding',
  },

  // --- whole-cluster binding, wildcards and cluster resources -------------
  {
    name: 'whole: wildcard allowed',
    bindings: [bind('OPERATOR', WHOLE)],
    request: { permission: 'backup:create', namespaces: ['*'] },
    expect: 'allow',
  },
  {
    name: 'whole: empty list allowed',
    bindings: [bind('OPERATOR', WHOLE)],
    request: { permission: 'backup:create', namespaces: [] },
    expect: 'allow',
  },
  {
    name: 'whole: cluster resources allowed',
    bindings: [bind('RESTORER', WHOLE)],
    request: { permission: 'restore:create', namespaces: ['prod'], includesClusterScoped: true },
    expect: 'allow',
  },
  {
    name: 'whole binding beats a scoped one',
    bindings: [bind('OPERATOR', ns('dev')), bind('OPERATOR', WHOLE)],
    request: { permission: 'backup:create', namespaces: ['prod'] },
    expect: 'allow',
  },
  {
    name: 'whole viewer + scoped operator: write stays scoped',
    bindings: [bind('VIEWER', WHOLE), bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['prod'] },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'whole viewer + scoped operator: write in scope',
    bindings: [bind('VIEWER', WHOLE), bind('OPERATOR', ns('dev'))],
    request: { permission: 'backup:create', namespaces: ['dev'] },
    expect: 'allow',
  },

  // --- selector scopes -------------------------------------------------------
  {
    name: 'selector: labels unknown denies',
    bindings: [bind('OPERATOR', { type: 'SELECTOR', selector: { matchLabels: { team: 'a' } } })],
    request: { permission: 'backup:create', namespaces: ['dev'] },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'selector: matching labels allow',
    bindings: [bind('OPERATOR', { type: 'SELECTOR', selector: { matchLabels: { team: 'a' } } })],
    request: {
      permission: 'backup:create',
      namespaces: ['dev'],
      namespaceLabels: { dev: { team: 'a', env: 'x' } },
    },
    expect: 'allow',
  },
  {
    name: 'selector: label value mismatch denies',
    bindings: [bind('OPERATOR', { type: 'SELECTOR', selector: { matchLabels: { team: 'a' } } })],
    request: {
      permission: 'backup:create',
      namespaces: ['dev'],
      namespaceLabels: { dev: { team: 'b' } },
    },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'selector: one of two namespaces unlabeled denies',
    bindings: [bind('OPERATOR', { type: 'SELECTOR', selector: { matchLabels: { team: 'a' } } })],
    request: {
      permission: 'backup:create',
      namespaces: ['dev', 'prod'],
      namespaceLabels: { dev: { team: 'a' } },
    },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'selector: empty selector is refused, not "everything"',
    bindings: [bind('OPERATOR', { type: 'SELECTOR', selector: { matchLabels: {} } })],
    request: { permission: 'backup:create', namespaces: ['dev'], namespaceLabels: { dev: {} } },
    expect: 'no-binding',
  },
  {
    name: 'selector: inherited property is not a label',
    bindings: [
      bind('OPERATOR', { type: 'SELECTOR', selector: { matchLabels: { constructor: 'x' } } }),
    ],
    request: { permission: 'backup:create', namespaces: ['dev'], namespaceLabels: { dev: {} } },
    expect: 'namespace-out-of-scope',
  },
  {
    name: 'selector: wildcard denied',
    bindings: [bind('OPERATOR', { type: 'SELECTOR', selector: { matchLabels: { team: 'a' } } })],
    request: {
      permission: 'backup:create',
      namespaces: ['*'],
      namespaceLabels: { '*': { team: 'a' } },
    },
    expect: 'wildcard-needs-cluster-scope',
  },
];

describe('authorize', () => {
  it('has at least 50 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const decision = run(c);
    if (c.expect === 'allow') {
      expect(decision.allowed).toBe(true);
    } else {
      expect(decision).toEqual({ allowed: false, reason: c.expect });
    }
  });

  it('reports how access was granted', () => {
    expect(
      authorize(
        { ...member(), orgRole: 'OWNER' },
        { clusterId: C1, permission: 'cluster:read' },
        [],
      ),
    ).toEqual({ allowed: true, via: 'org-role' });
    expect(
      authorize(member(), { clusterId: C1, permission: 'cluster:read' }, [bind('VIEWER', WHOLE)]),
    ).toEqual({ allowed: true, via: 'binding' });
  });
});

describe('role definitions', () => {
  it('match the table in PLAN.md §8.2', () => {
    const has = (role: (typeof CLUSTER_ROLES)[number], p: (typeof PERMISSIONS)[number]) =>
      BUILT_IN_ROLES[role].includes(p);

    // Row by row, so a change to the table has to change this test too.
    for (const p of [
      'cluster:read',
      'backup:read',
      'restore:read',
      'schedule:read',
      'storage:read',
    ] as const) {
      for (const r of CLUSTER_ROLES) expect(has(r, p), `${r} ${p}`).toBe(true);
    }
    for (const p of ['backup:logs', 'restore:logs', 'logs:read', 'backup:create'] as const) {
      expect(has('VIEWER', p), `VIEWER ${p}`).toBe(false);
      for (const r of ['OPERATOR', 'RESTORER', 'CLUSTER_ADMIN'] as const) {
        expect(has(r, p), `${r} ${p}`).toBe(true);
      }
    }
    expect(CLUSTER_ROLES.filter((r) => has(r, 'schedule:write'))).toEqual([
      'OPERATOR',
      'CLUSTER_ADMIN',
    ]);
    expect(CLUSTER_ROLES.filter((r) => has(r, 'restore:create'))).toEqual([
      'RESTORER',
      'CLUSTER_ADMIN',
    ]);
    for (const p of [
      'backup:delete',
      'restore:delete',
      'schedule:delete',
      'storage:write',
      'backup:download',
      'advanced:write',
      'cluster:manage',
    ] as const) {
      expect(
        CLUSTER_ROLES.filter((r) => has(r, p)),
        p,
      ).toEqual(['CLUSTER_ADMIN']);
    }
  });

  it('only lists known permissions and no duplicates', () => {
    for (const role of CLUSTER_ROLES) {
      const list = BUILT_IN_ROLES[role];
      expect(new Set(list).size).toBe(list.length);
      for (const p of list) expect(PERMISSIONS).toContain(p);
    }
  });
});

describe('normaliseScope', () => {
  it.each([
    [{ type: 'CLUSTER' }, { type: 'CLUSTER' }],
    [ns('a', 'a', 'b'), ns('a', 'b')],
    [undefined, null],
    [[], null],
    [{ type: 'NAMESPACES' }, null],
    [{ type: 'NAMESPACES', namespaces: 'dev' }, null],
    [{ type: 'NAMESPACES', namespaces: ['UPPER'] }, null],
    [{ type: 'NAMESPACES', namespaces: ['a_b'] }, null],
    [{ type: 'SELECTOR', selector: { matchLabels: { a: 1 } } }, null],
  ])('%j -> %j', (input, output) => {
    expect(normaliseScope(input)).toEqual(output);
  });
});

describe('restoreNamespaces', () => {
  it('includes both sides of a mapping', () => {
    expect(restoreNamespaces(['a', 'b'], { a: 'x' }).sort()).toEqual(['a', 'b', 'x']);
  });

  it('ignores prototype keys in the mapping', () => {
    expect(restoreNamespaces(['constructor'], {})).toEqual(['constructor']);
  });
});

describe('visibleNamespaces', () => {
  const view = (bindings: RoleBinding[], known: string[], p: Principal = member()) =>
    visibleNamespaces(p, C1, 'backup:read', bindings, {}, undefined, known);

  it('is everything for a whole-cluster binding', () => {
    expect(view([bind('VIEWER', WHOLE)], [])).toBe('all');
  });

  it('is everything for an org admin', () => {
    expect(view([], [], { ...member(), orgRole: 'ADMIN' })).toBe('all');
  });

  it('is the intersection of scope and what the cluster reports', () => {
    expect(view([bind('VIEWER', ns('dev', 'stage'))], ['dev', 'prod'])).toEqual(['dev']);
  });

  it('is nothing without a binding or for a non-member', () => {
    expect(view([], ['dev'])).toEqual([]);
    expect(
      view([bind('VIEWER', WHOLE)], ['dev'], { userId: ALICE, orgRole: undefined, teamIds: [] }),
    ).toEqual([]);
  });

  it('is nothing for a role without the permission', () => {
    expect(
      visibleNamespaces(member(), C1, 'backup:logs', [bind('VIEWER', ns('dev'))], {}, undefined, [
        'dev',
      ]),
    ).toEqual([]);
  });
});

describe('mayAttempt', () => {
  const ok = (bindings: RoleBinding[], permission = 'backup:create', p: Principal = member()) =>
    mayAttempt(p, C1, permission, bindings);

  it('lets a scoped user through to the handler', () => {
    expect(ok([bind('OPERATOR', ns('dev'))])).toBe(true);
  });

  it('refuses a role that lacks the permission', () => {
    expect(ok([bind('VIEWER', ns('dev'))])).toBe(false);
  });

  it('refuses a binding with an unreadable scope', () => {
    expect(ok([bind('OPERATOR', { type: 'NAMESPACES', namespaces: ['*'] })])).toBe(false);
  });

  it('refuses another cluster, a non-member and an unknown permission', () => {
    expect(ok([bind('OPERATOR', WHOLE, { clusterId: C2 })])).toBe(false);
    expect(
      ok([bind('OPERATOR', WHOLE)], 'backup:create', { ...member(), orgRole: undefined }),
    ).toBe(false);
    expect(ok([bind('OPERATOR', WHOLE)], 'bogus')).toBe(false);
  });

  it('honours the download setting and org roles', () => {
    expect(ok([], 'backup:download', { ...member(), orgRole: 'OWNER' })).toBe(false);
    expect(
      mayAttempt({ ...member(), orgRole: 'ADMIN' }, C1, 'backup:download', [], {
        allowBackupContentDownload: true,
      }),
    ).toBe(true);
  });
});

describe('API token limits', () => {
  const tokenOf = (
    permissions: string[] | null,
    clusterIds: string[] | null,
    orgRole: Principal['orgRole'] = 'MEMBER',
  ): Principal => ({ ...member(), orgRole, tokenLimit: { permissions, clusterIds } });
  const ask = (
    p: Principal,
    permission: string,
    cluster = C1,
    b = [bind('CLUSTER_ADMIN', WHOLE)],
  ) => authorize(p, { clusterId: cluster, permission, namespaces: [] }, b);

  it('narrows to the listed permissions', () => {
    const p = tokenOf(['backup:read'], null);
    expect(ask(p, 'backup:read').allowed).toBe(true);
    expect(ask(p, 'backup:delete')).toEqual({ allowed: false, reason: 'token-limit' });
  });

  it('narrows to the listed clusters', () => {
    const p = tokenOf(null, [C1]);
    expect(ask(p, 'backup:read').allowed).toBe(true);
    expect(ask(p, 'backup:read', C2, [bind('CLUSTER_ADMIN', WHOLE, { clusterId: C2 })])).toEqual({
      allowed: false,
      reason: 'token-limit',
    });
  });

  it('cannot widen what the owner holds', () => {
    const p = tokenOf(['backup:delete'], null);
    expect(ask(p, 'backup:delete', C1, [bind('VIEWER', WHOLE)])).toEqual({
      allowed: false,
      reason: 'no-binding',
    });
  });

  it('limits an org owner too', () => {
    const p = tokenOf(['backup:read'], null, 'OWNER');
    expect(ask(p, 'cluster:manage', C1, []).allowed).toBe(false);
    expect(ask(p, 'backup:read', C1, []).allowed).toBe(true);
  });

  it('null means no extra limit, not every permission', () => {
    const p = tokenOf(null, null);
    expect(ask(p, 'cluster:manage', C1, [bind('VIEWER', WHOLE)]).allowed).toBe(false);
  });

  it('applies to mayAttempt as well', () => {
    expect(
      mayAttempt(tokenOf(['backup:read'], null), C1, 'backup:delete', [
        bind('CLUSTER_ADMIN', WHOLE),
      ]),
    ).toBe(false);
  });

  it('an empty permission list grants nothing', () => {
    expect(ask(tokenOf([], null), 'cluster:read').allowed).toBe(false);
  });
});
