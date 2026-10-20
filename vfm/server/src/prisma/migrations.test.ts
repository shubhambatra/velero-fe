import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Zero-downtime upgrades (PLAN.md section 13, R-123): a rolling upgrade runs the previous release against
 * the new schema for a while, so a migration may only EXPAND the schema. Removing or reshaping
 * something is a second release, after the first is everywhere ("expand, migrate, contract").
 *
 * The rule is checked on the SQL itself. A migration that genuinely is the contract step says so
 * with a `-- vfm:contract <why it is safe now>` line, which a reviewer sees in the diff.
 */
const DIR = resolve(__dirname, '../../prisma/migrations');

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'drops a table', pattern: /\bDROP\s+TABLE\b/i },
  { name: 'drops a column', pattern: /\bDROP\s+COLUMN\b/i },
  { name: 'drops a type', pattern: /\bDROP\s+TYPE\b/i },
  { name: 'renames something', pattern: /\bRENAME\b/i },
  { name: 'changes a column', pattern: /\bALTER\s+COLUMN\b/i },
  // A statement that starts with it; `REVOKE ... TRUNCATE` and a `BEFORE TRUNCATE` trigger are guards.
  { name: 'empties a table', pattern: /^\s*TRUNCATE\b/im },
  { name: 'deletes rows', pattern: /^\s*DELETE\s+FROM\b/im },
  // The previous release inserts rows without the new column and would fail.
  {
    name: 'adds a NOT NULL column with no default',
    pattern:
      /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?\w+"?\s+[^,;]*?\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i,
  },
];

export function problemsWith(sql: string): string[] {
  const stripped = sql.replace(/--.*$/gm, '');
  return FORBIDDEN.filter(({ pattern }) => pattern.test(stripped)).map(({ name }) => name);
}

export function isContractStep(sql: string): boolean {
  return /^--[ \t]*vfm:contract[ \t]+\S/m.test(sql);
}

describe('migrations only expand the schema', () => {
  it('has migrations to check', () => {
    expect(readdirSync(DIR).filter((d) => /^\d{14}_/.test(d)).length).toBeGreaterThan(10);
  });

  for (const name of readdirSync(DIR).filter((d) => /^\d{14}_/.test(d))) {
    it(`${name} is backward compatible with the previous release`, () => {
      const sql = readFileSync(resolve(DIR, name, 'migration.sql'), 'utf8');
      if (isContractStep(sql)) {
        return;
      }
      expect(
        problemsWith(sql),
        'add `-- vfm:contract <why>` only for a reviewed contract step',
      ).toEqual([]);
    });
  }

  describe('the checker itself', () => {
    it('lets additive changes through', () => {
      expect(
        problemsWith(`
          CREATE TABLE "x" ("id" UUID NOT NULL);
          ALTER TABLE "y" ADD COLUMN "note" TEXT;
          ALTER TABLE "y" ADD COLUMN "n" INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE "y" ADD CONSTRAINT "fk" FOREIGN KEY ("a") REFERENCES "x"("id");
          ALTER TYPE "s" ADD VALUE 'NEW';
          CREATE INDEX "i" ON "y"("n");
        `),
      ).toEqual([]);
    });

    it('catches each way of breaking the previous release', () => {
      expect(problemsWith('DROP TABLE "x";')).toContain('drops a table');
      expect(problemsWith('ALTER TABLE "x" DROP COLUMN "c";')).toContain('drops a column');
      expect(problemsWith('ALTER TABLE "x" RENAME COLUMN "a" TO "b";')).toContain(
        'renames something',
      );
      expect(problemsWith('ALTER TABLE "x" RENAME TO "z";')).toContain('renames something');
      expect(problemsWith('ALTER TABLE "x" ALTER COLUMN "a" TYPE TEXT;')).toContain(
        'changes a column',
      );
      expect(problemsWith('ALTER TABLE "x" ALTER COLUMN "a" SET NOT NULL;')).toContain(
        'changes a column',
      );
      expect(problemsWith('TRUNCATE "x";')).toContain('empties a table');
      // ...but not the guards that forbid it.
      expect(problemsWith('REVOKE UPDATE, DELETE, TRUNCATE ON "a" FROM PUBLIC;')).toEqual([]);
      expect(problemsWith('CREATE TRIGGER t BEFORE TRUNCATE ON "a" EXECUTE FUNCTION f();')).toEqual(
        [],
      );
      expect(problemsWith('DELETE FROM "x";')).toContain('deletes rows');
      expect(problemsWith('ALTER TABLE "x" ADD COLUMN "c" TEXT NOT NULL;')).toContain(
        'adds a NOT NULL column with no default',
      );
    });

    it('ignores what is only in a comment, and honours a reasoned contract marker', () => {
      expect(problemsWith('-- DROP TABLE "x"\nSELECT 1;')).toEqual([]);
      expect(
        isContractStep(
          '-- vfm:contract nothing reads column c since 0.2.0\nALTER TABLE a DROP COLUMN c;',
        ),
      ).toBe(true);
      // A marker with no reason does not count.
      expect(isContractStep('-- vfm:contract\nALTER TABLE a DROP COLUMN c;')).toBe(false);
    });
  });
});
