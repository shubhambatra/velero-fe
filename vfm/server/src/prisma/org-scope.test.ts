import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALL_MODELS,
  applyOrgScope,
  NOT_ORG_OWNED,
  ORG_OWNED_MODELS,
  OrgScopeError,
  runInOrg,
  runUnscoped,
} from './org-scope';

const ORG = '0192f2a0-0000-7000-8000-00000000000a';
const OTHER = '0192f2a0-0000-7000-8000-00000000000b';
const owned = [...ORG_OWNED_MODELS];

describe('model classification (PLAN.md §8.1: impossible to forget)', () => {
  it('classifies every model as org-owned or explicitly exempt', () => {
    const unclassified = ALL_MODELS.filter(
      (m) => !ORG_OWNED_MODELS.has(m) && !(m in NOT_ORG_OWNED),
    );
    // A new table without orgId lands here until someone decides, in writing,
    // that it is not tenant data.
    expect(unclassified).toEqual([]);
  });

  it('treats the day-6 tables as org-owned', () => {
    expect(owned).toEqual(expect.arrayContaining(['Membership', 'Team', 'TeamMember', 'Invite']));
  });

  it('does not exempt anything that has an orgId', () => {
    for (const model of Object.keys(NOT_ORG_OWNED)) {
      expect(ORG_OWNED_MODELS.has(model)).toBe(false);
    }
  });
});

describe('queries outside a scope', () => {
  const reads = ['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy'];
  const writes = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];

  it.each(owned.flatMap((m) => [...reads, ...writes].map((op) => [m, op] as const)))(
    '%s.%s throws without inOrg()',
    (model, operation) => {
      expect(() => applyOrgScope({ model, operation, args: { where: { id: 'x' } } })).toThrow(
        OrgScopeError,
      );
    },
  );

  it('throws when a non-owned model selects an org-owned relation', () => {
    expect(() =>
      applyOrgScope({
        model: 'User',
        operation: 'findUnique',
        args: { where: { id: 'x' }, select: { memberships: true } },
      }),
    ).toThrow(OrgScopeError);
  });

  it('leaves non-owned models alone', () => {
    const args = { where: { id: 'x' } };
    expect(applyOrgScope({ model: 'User', operation: 'findUnique', args })).toBe(args);
  });
});

describe('queries inside inOrg()', () => {
  const run = <T>(fn: () => T): Promise<T> => runInOrg(ORG, () => Promise.resolve(fn()));

  it.each(owned)('%s: findMany is constrained to the org', async (model) => {
    const out = await run(() =>
      applyOrgScope({ model, operation: 'findMany', args: { where: { id: 'x' } } }),
    );
    expect(out).toEqual({ where: { AND: [{ id: 'x' }, { orgId: ORG }] } });
  });

  it.each(owned)('%s: a findMany with no where is still constrained', async (model) => {
    const out = await run(() => applyOrgScope({ model, operation: 'findMany', args: undefined }));
    expect(out).toEqual({ where: { orgId: ORG } });
  });

  it.each(owned)('%s: create is stamped with the org', async (model) => {
    const out = await run(() =>
      applyOrgScope({ model, operation: 'create', args: { data: { id: 'x' } } }),
    );
    expect(out).toEqual({ data: { id: 'x', orgId: ORG } });
  });

  it.each(owned)('%s: createMany stamps every row', async (model) => {
    const out = await run(() =>
      applyOrgScope({ model, operation: 'createMany', args: { data: [{ id: 'a' }, { id: 'b' }] } }),
    );
    expect(out).toEqual({
      data: [
        { id: 'a', orgId: ORG },
        { id: 'b', orgId: ORG },
      ],
    });
  });

  it.each(owned)('%s: a unique lookup gains the org as a filter', async (model) => {
    const out = await run(() =>
      applyOrgScope({ model, operation: 'findUnique', args: { where: { id: 'x' } } }),
    );
    expect(out).toEqual({ where: { id: 'x', orgId: ORG } });
  });

  it.each(
    owned.flatMap((m) =>
      ['findMany', 'updateMany', 'deleteMany', 'count'].map((o) => [m, o] as const),
    ),
  )('%s.%s refuses a where that names another org', async (model, operation) => {
    await expect(
      run(() => applyOrgScope({ model, operation, args: { where: { orgId: OTHER } } })),
    ).rejects.toThrow(/different org/);
  });

  it.each(owned)('%s: create refuses a body naming another org', async (model) => {
    await expect(
      run(() => applyOrgScope({ model, operation: 'create', args: { data: { orgId: OTHER } } })),
    ).rejects.toThrow(/different org/);
  });

  it.each(owned)('%s: update cannot move a row to another org', async (model) => {
    await expect(
      run(() =>
        applyOrgScope({
          model,
          operation: 'update',
          args: { where: { id: 'x' }, data: { orgId: OTHER } },
        }),
      ),
    ).rejects.toThrow(/different org/);
  });

  it.each(owned)('%s: the org relation form cannot connect an arbitrary org', async (model) => {
    await expect(
      run(() =>
        applyOrgScope({
          model,
          operation: 'create',
          args: { data: { org: { connect: { id: OTHER } } } },
        }),
      ),
    ).rejects.toThrow(/scalar orgId/);
  });

  it('pins a nested org-owned relation to the org', async () => {
    const out = await run(() =>
      applyOrgScope({
        model: 'User',
        operation: 'findUnique',
        args: { where: { id: 'u' }, select: { memberships: true } },
      }),
    );
    expect(out).toEqual({
      where: { id: 'u' },
      select: { memberships: { where: { orgId: ORG } } },
    });
  });

  it('upsert scopes where, create and update', async () => {
    const out = await run(() =>
      applyOrgScope({
        model: 'Team',
        operation: 'upsert',
        args: { where: { id: 'x' }, create: { id: 'x' }, update: { name: 'n' } },
      }),
    );
    expect(out).toEqual({
      where: { id: 'x', orgId: ORG },
      create: { id: 'x', orgId: ORG },
      update: { name: 'n' },
    });
  });
});

describe('unscoped()', () => {
  it('passes queries through untouched', async () => {
    const args = { where: { userId: 'u' } };
    const out = await runUnscoped('test', () =>
      Promise.resolve(applyOrgScope({ model: 'Membership', operation: 'findMany', args })),
    );
    expect(out).toBe(args);
  });

  it('requires a reason', () => {
    expect(() => runUnscoped('  ', () => Promise.resolve())).toThrow(OrgScopeError);
  });
});

/**
 * The part no Prisma extension can see: raw SQL, and the escape hatch itself.
 * Both are pinned to short lists so adding one is a conscious, reviewed change
 * rather than something that slips in beside a feature.
 */
describe('static guard over the source tree', () => {
  const root = join(__dirname, '..');

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        return sources(path);
      }
      return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
    });
  }

  const files = sources(root).map((path) => ({
    name: relative(root, path),
    // Comments are dropped so prose about `$queryRaw` is not mistaken for use.
    text: readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n'),
  }));

  it('uses raw SQL only where it cannot touch tenant data', () => {
    const offenders = files
      .filter((f) => /\$(queryRaw|executeRaw)(Unsafe)?\b/.test(f.text))
      .map((f) => f.name)
      .sort();
    // health: `SELECT 1`. Anything else needs its own org-scoping argument.
    expect(offenders).toEqual(['prisma/prisma.service.ts']);
  });

  it('keeps every unscoped() call site on the reviewed list', () => {
    const sites = files
      .flatMap((f) =>
        [...f.text.matchAll(/\.unscoped\(\s*'([^']+)'/g)].map((m) => `${f.name}: ${m[1] ?? ''}`),
      )
      .sort();

    expect(sites).toEqual([
      'audit/audit.service.ts: audit events may precede org selection and outlive the org',
      'auth/mfa.service.ts: mfa obligation spans all of a user’s orgs',
      'oidc/oidc-login.service.ts: an oidc provider id identifies its org',
      'orgs/invites.service.ts: an invite token identifies its org',
      'orgs/orgs.service.ts: a user lists their own memberships (org switcher)',
      'tokens/api-tokens.service.ts: an api token identifies its org',
    ]);
  });
});
