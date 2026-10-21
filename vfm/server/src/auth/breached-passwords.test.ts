import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BREACHED_LIST_PATH, loadList } from './breached-passwords';

/**
 * The list is a shipped asset, not code, so it has its own failure mode:
 * `tsc` emits only JavaScript, and a build that forgets to copy `src/auth/data`
 * produces a server that cannot start. That happened once; these tests are
 * what stop it recurring.
 */
describe('the bundled breached-password list as a build artifact', () => {
  it('sits beside the module that loads it, under src', () => {
    expect(existsSync(join(__dirname, 'data', 'breached-passwords.txt.gz'))).toBe(true);
  });

  it('is resolved relative to the module, so it works from src and from dist', () => {
    // An absolute or cwd-relative path would work under `tsx` and break in the
    // built image, where the process starts from a different directory.
    expect(BREACHED_LIST_PATH).toContain(join('auth', 'data'));
    expect(BREACHED_LIST_PATH.startsWith(__dirname)).toBe(true);
  });

  it('refuses to load an empty list rather than silently disabling the check', async () => {
    // A missing or truncated asset must fail startup: a check that always
    // returns "not breached" is worse than no check, because it looks like one
    // (PLAN.md §0 rule 7).
    await expect(loadList('/nonexistent/breached.txt.gz')).rejects.toThrow();
  });

  it('loads the committed asset and finds a known-weak password in it', async () => {
    const list = await loadList();

    expect(list.size).toBeGreaterThan(90_000);
    expect(list.has('password')).toBe(true);
  });
});
