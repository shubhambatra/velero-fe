import { describe, expect, it } from 'vitest';

import { longestGapSeconds, parseCron } from './cron.js';

const gap = (expression: string, from = new Date('2026-10-14T10:00:00Z')): number | null => {
  const parsed = parseCron(expression);
  return 'cron' in parsed ? longestGapSeconds(parsed.cron, from) : null;
};

describe('longestGapSeconds', () => {
  it('is the interval of a regular schedule', () => {
    expect(gap('0 * * * *')).toBe(3600);
    expect(gap('0 2 * * *')).toBe(86_400);
    expect(gap('@every 90m')).toBe(5400);
  });

  it('sees the weekend of a weekdays-only schedule', () => {
    // Wednesday 14 October: the next ten runs span a weekend, Friday 02:00 to Monday 02:00.
    expect(gap('0 2 * * 1-5')).toBe(3 * 86_400);
  });

  it('sees the longest month of a monthly schedule', () => {
    expect(gap('0 0 1 * *')).toBe(31 * 86_400);
  });

  it('is null for an expression that never runs', () => {
    expect(gap('0 0 31 2 *')).toBeNull();
  });
});
