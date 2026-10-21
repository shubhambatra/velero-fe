import { describe, expect, it } from 'vitest';

import { isFresh, SudoGuard } from './sudo.guard';

describe('the sudo window (PLAN.md §8.3)', () => {
  const now = Date.parse('2026-10-15T10:00:00.000Z');

  it('is five minutes', () => {
    expect(SudoGuard.WINDOW_MS).toBe(5 * 60 * 1_000);
  });

  it('accepts a re-authentication from just now', () => {
    expect(isFresh(now, now)).toBe(true);
  });

  it('accepts one from four minutes ago', () => {
    expect(isFresh(now - 4 * 60 * 1_000, now)).toBe(true);
  });

  it('accepts one exactly on the boundary', () => {
    expect(isFresh(now - SudoGuard.WINDOW_MS, now)).toBe(true);
  });

  it('rejects one a millisecond past the boundary', () => {
    expect(isFresh(now - SudoGuard.WINDOW_MS - 1, now)).toBe(false);
  });

  it('rejects one from an hour ago', () => {
    expect(isFresh(now - 60 * 60 * 1_000, now)).toBe(false);
  });

  it('rejects a timestamp from the future rather than trusting it forever', () => {
    // A clock that jumped backwards would otherwise leave the window open
    // indefinitely, which is the opposite of what the control is for.
    expect(isFresh(now + 1_000, now)).toBe(false);
  });
});
