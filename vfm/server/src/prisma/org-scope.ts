import { AsyncLocalStorage } from 'node:async_hooks';

import { Prisma } from '@prisma/client';

/**
 * Organization scoping for every database query (PLAN.md §8.1: "All data
 * queries are *always* filtered by `org_id`. Enforce it in a Prisma
 * middleware/extension so it cannot be forgotten.").
 *
 * ## The rule
 *
 * A model is **org-owned** when it has an `orgId` column. That is derived from
 * the generated client rather than listed by hand, so a table added in a later
 * milestone is scoped the moment it has an `orgId` and nobody has to remember
 * to register it.
 *
 * Touching an org-owned model requires an ambient scope, set with
 * `PrismaService.inOrg()` or, deliberately and visibly, `unscoped()`. With no
 * scope the query throws {@link OrgScopeError} — forgetting is a loud failure
 * in the first test that exercises the path, never a silent cross-tenant read.
 *
 * Inside `inOrg(orgId)` the extension does the filtering itself: it adds
 * `orgId` to every `where`, stamps it on every `create`, and refuses any
 * attempt to write a different one. A caller cannot widen the scope by passing
 * its own `orgId`, only repeat the one already in force.
 *
 * ## What this does not cover
 *
 * Raw SQL (`$queryRaw`, `$executeRaw`) bypasses Prisma's query layer, so no
 * extension can see it. `org-scope.test.ts` fails if either appears outside
 * the short allow-list there.
 */

/**
 * Models that deliberately have no `orgId`, with the reason each is exempt.
 *
 * A model missing from both this list and the org-owned set fails the test in
 * `org-scope.test.ts`, which is what forces a decision when a table is added.
 */
export const NOT_ORG_OWNED: Readonly<Record<string, string>> = {
  User: 'global identity; a user may belong to several orgs (PLAN.md §8.1)',
  MfaRecoveryCode: 'belongs to a user, not an org (docs/DECISIONS.md ADR-008)',
  Organization: 'the tenant itself; reached by id after a membership check',
};

function scalarFields(model: string): readonly string[] {
  const enumeration = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[
    `${model}ScalarFieldEnum`
  ];
  return enumeration === undefined ? [] : Object.values(enumeration);
}

/** Every model name the generated client knows about. */
export const ALL_MODELS: readonly string[] = Object.values(Prisma.ModelName);

/** Models with an `orgId` column, which the extension scopes. */
export const ORG_OWNED_MODELS: ReadonlySet<string> = new Set(
  ALL_MODELS.filter((model) => scalarFields(model).includes('orgId')),
);

export type ScopeContext =
  | { readonly mode: 'org'; readonly orgId: string }
  | { readonly mode: 'unscoped'; readonly reason: string };

const store = new AsyncLocalStorage<ScopeContext>();

export function currentScope(): ScopeContext | undefined {
  return store.getStore();
}

/** Runs `fn` with every org-owned query inside it pinned to `orgId`. */
export function runInOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  if (orgId === '') {
    throw new OrgScopeError('inOrg() requires a non-empty org id');
  }
  // `await` inside the run: a Prisma query is a lazy promise that only executes
  // when something awaits it, so returning it unawaited would run the query
  // after the scope had already been left.
  return store.run({ mode: 'org', orgId }, async () => await fn());
}

/**
 * Runs `fn` with org scoping explicitly suspended.
 *
 * For the few operations that are cross-org by nature — a user listing the
 * orgs they belong to, resolving an invite from its token. `reason` is
 * mandatory and appears at the call site, which is what makes every use
 * reviewable (and greppable: `org-scope.test.ts` pins the full list).
 */
export function runUnscoped<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  if (reason.trim() === '') {
    throw new OrgScopeError('unscoped() requires a reason');
  }
  return store.run({ mode: 'unscoped', reason }, async () => await fn());
}

export class OrgScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgScopeError';
  }
}

type Json = Record<string, unknown>;

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Adds `orgId` to a `where`, refusing a conflicting one. */
function scopeWhere(where: unknown, orgId: string, model: string): Json {
  if (where === undefined || where === null) {
    return { orgId };
  }
  if (!isObject(where)) {
    throw new OrgScopeError(`${model}: unexpected where clause`);
  }
  if ('orgId' in where && where.orgId !== orgId) {
    throw new OrgScopeError(
      `${model}: query names a different org than the one in scope (cross-org access refused)`,
    );
  }
  // AND rather than a spread, so an `OR` at the top level cannot be used to
  // step outside the org: `{ OR: [...], orgId }` would still be correct, but
  // AND makes the guarantee structural instead of depending on that.
  return { AND: [where, { orgId }] };
}

function scopeUniqueWhere(where: unknown, orgId: string, model: string): Json {
  if (!isObject(where)) {
    throw new OrgScopeError(`${model}: unique lookup without a where clause`);
  }
  if ('orgId' in where && where.orgId !== orgId) {
    throw new OrgScopeError(
      `${model}: query names a different org than the one in scope (cross-org access refused)`,
    );
  }
  // Prisma accepts extra non-unique filters alongside a unique key, so the org
  // becomes part of the lookup: another org's row is simply "not found".
  return { ...where, orgId };
}

function scopeData(data: unknown, orgId: string, model: string, creating: boolean): Json {
  if (!isObject(data)) {
    throw new OrgScopeError(`${model}: write without a data object`);
  }
  if ('org' in data) {
    // The relation form would let a caller `connect` an arbitrary org.
    throw new OrgScopeError(`${model}: write the scalar orgId, not the org relation`);
  }
  if ('orgId' in data && data.orgId !== orgId) {
    throw new OrgScopeError(`${model}: cannot write a row into a different org`);
  }
  return creating ? { ...data, orgId } : data;
}

/**
 * Relations to org-owned models selected from a model that is not itself
 * org-owned — `user.memberships` being the live example. A top-level model
 * check would not see these, so they are walked explicitly.
 */
function nestedOrgOwned(args: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (!isObject(node)) {
      return;
    }
    for (const key of ['select', 'include'] as const) {
      const selection = node[key];
      if (!isObject(selection)) {
        continue;
      }
      for (const [field, value] of Object.entries(selection)) {
        if (value === false) {
          continue;
        }
        if (relationTargets(field).some((target) => ORG_OWNED_MODELS.has(target))) {
          found.push(field);
        }
        walk(value);
      }
    }
  };
  walk(args);
  return found;
}

/** Relation field name → possible target models, by Prisma's naming. */
function relationTargets(field: string): string[] {
  // Prisma's own model metadata is not public API in v7; relation fields in
  // this schema are the camelCase plural/singular of the model they point at.
  const candidates = new Set<string>();
  const pascal = field.charAt(0).toUpperCase() + field.slice(1);
  candidates.add(pascal);
  if (pascal.endsWith('ies')) {
    candidates.add(`${pascal.slice(0, -3)}y`);
  }
  if (pascal.endsWith('s')) {
    candidates.add(pascal.slice(0, -1));
  }
  return [...candidates].filter((name) => ALL_MODELS.includes(name));
}

export interface ScopedOperation {
  model: string;
  operation: string;
  args: unknown;
}

/**
 * Applies the scope to one operation, returning the arguments to run.
 *
 * Pure apart from reading the ambient scope, which is why `org-scope.test.ts`
 * can drive it across every model and operation without a database.
 */
export function applyOrgScope({ model, operation, args }: ScopedOperation): unknown {
  const owned = ORG_OWNED_MODELS.has(model);
  const nested = owned ? [] : nestedOrgOwned(args);

  if (!owned && nested.length === 0) {
    return args;
  }

  const scope = currentScope();
  if (scope === undefined) {
    const what = owned
      ? `${model}.${operation}`
      : `${model}.${operation} (selects ${nested.join(', ')})`;
    throw new OrgScopeError(
      `${what} touches org-owned data outside an org scope; wrap it in prisma.inOrg(orgId, …) ` +
        `or, if it is cross-org by nature, prisma.unscoped(reason, …)`,
    );
  }

  if (scope.mode === 'unscoped') {
    return args;
  }

  if (!owned) {
    // Nested selection inside an org scope: pin each org-owned relation to the
    // org, so `user.memberships` returns only this org's rows.
    return scopeNested(isObject(args) ? args : {}, scope.orgId);
  }

  const next: Json = isObject(args) ? { ...args } : {};

  if (WHERE_OPERATIONS.has(operation)) {
    const unique =
      operation.startsWith('findUnique') ||
      operation === 'update' ||
      operation === 'delete' ||
      operation === 'upsert';
    next.where = unique
      ? scopeUniqueWhere(next.where, scope.orgId, model)
      : scopeWhere(next.where, scope.orgId, model);
  }

  if (CREATE_OPERATIONS.has(operation)) {
    if (operation === 'createMany' || operation === 'createManyAndReturn') {
      const rows: unknown = next.data;
      const list = Array.isArray(rows) ? (rows as unknown[]) : [rows];
      next.data = list.map((row) => scopeData(row, scope.orgId, model, true));
    } else if (operation === 'upsert') {
      next.create = scopeData(next.create, scope.orgId, model, true);
      next.update = scopeData(next.update, scope.orgId, model, false);
    } else {
      next.data = scopeData(next.data, scope.orgId, model, true);
    }
  }

  if (operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') {
    next.data = scopeData(next.data, scope.orgId, model, false);
  }

  return scopeNested(next, scope.orgId);
}

function scopeNested(args: Json, orgId: string): Json {
  const result: Json = { ...args };
  for (const key of ['select', 'include'] as const) {
    const selection = result[key];
    if (!isObject(selection)) {
      continue;
    }
    const rewritten: Json = {};
    for (const [field, value] of Object.entries(selection)) {
      const ownedTarget = relationTargets(field).some((target) => ORG_OWNED_MODELS.has(target));
      if (value === false || value === undefined) {
        rewritten[field] = value;
      } else if (!ownedTarget) {
        rewritten[field] = isObject(value) ? scopeNested(value, orgId) : value;
      } else if (value === true) {
        rewritten[field] = { where: { orgId } };
      } else if (isObject(value)) {
        const inner = scopeNested(value, orgId);
        rewritten[field] = { ...inner, where: scopeWhere(inner.where, orgId, field) };
      } else {
        rewritten[field] = value;
      }
    }
    result[key] = rewritten;
  }
  return result;
}

/** The Prisma client extension that enforces the scope on every operation. */
export const orgScopeExtension = Prisma.defineExtension({
  name: 'org-scope',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        return query(applyOrgScope({ model, operation, args }) as typeof args);
      },
    },
  },
});
