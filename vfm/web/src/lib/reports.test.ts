import { describe, expect, it } from 'vitest';

import { duration, percent, windowQuery } from './reports';

describe('percent', () => {
  it('shows one decimal and a dash for nothing', () => {
    expect(percent(1)).toBe('100 %');
    expect(percent(0)).toBe('0 %');
    expect(percent(5 / 7)).toBe('71.4 %');
    expect(percent(0.5833333)).toBe('58.3 %');
    expect(percent(null)).toBe('—');
  });
});

describe('duration', () => {
  it('is hours under two days and days above', () => {
    expect(duration(0)).toBe('0 h');
    expect(duration(5.55)).toBe('5.6 h');
    expect(duration(36)).toBe('36 h');
    expect(duration(47.9)).toBe('47.9 h');
    expect(duration(48)).toBe('2 d');
    expect(duration(100)).toBe('4 d 4 h');
    expect(duration(744)).toBe('31 d');
    expect(duration(null)).toBe('—');
  });
});

describe('windowQuery', () => {
  it('ends now and starts the given number of days earlier, as encoded ISO instants', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const q = new URLSearchParams(windowQuery(7, now));
    expect(q.get('to')).toBe('2026-10-17T12:00:00.000Z');
    expect(q.get('from')).toBe('2026-10-10T12:00:00.000Z');
    expect(windowQuery(7, now)).not.toContain(':');
  });
});
