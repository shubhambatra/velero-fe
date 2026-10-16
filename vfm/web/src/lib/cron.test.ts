import { describe, expect, it } from 'vitest';

import { expressionFor, nextRuns, parseCron, patternOf, type Cron } from './cron';

const cron = (expr: string): Cron => {
  const r = parseCron(expr);
  if ('error' in r) throw new Error(r.error);
  return r.cron;
};
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());
const at = (s: string) => new Date(s);

describe('parseCron', () => {
  it.each([
    '* * * * *',
    '0 2 * * *',
    '*/15 0-6 1,15 jan-mar mon-fri',
    '0 0 ? * sun',
    '@hourly',
    '@every 90m',
    '5/10 * * * *',
  ])('accepts %s', (expr) => {
    expect('cron' in parseCron(expr)).toBe(true);
  });

  it.each([
    ['', 'required'],
    ['* * * *', 'five fields'],
    ['60 * * * *', 'minute'],
    ['* 24 * * *', 'hour'],
    ['* * 0 * *', 'day of month'],
    ['* * * 13 *', 'month'],
    ['* * * * 7', 'day of week'],
    ['*/0 * * * *', 'step'],
    ['5-1 * * * *', 'backwards'],
    ['@sometimes', 'descriptor'],
    ['@every 0s', '@every'],
  ])('refuses %j', (expr, mention) => {
    const r = parseCron(expr);
    expect('error' in r && r.error).toContain(mention);
  });
});

describe('nextRuns', () => {
  it('lists the next runs of a daily schedule', () => {
    expect(iso(nextRuns(cron('30 2 * * *'), at('2026-10-16T02:30:00Z'), 3))).toEqual([
      '2026-10-17T02:30:00.000Z',
      '2026-10-18T02:30:00.000Z',
      '2026-10-19T02:30:00.000Z',
    ]);
  });

  it('starts later the same day when the time has not come', () => {
    expect(iso(nextRuns(cron('30 2 * * *'), at('2026-10-16T01:00:00Z'), 1))).toEqual([
      '2026-10-16T02:30:00.000Z',
    ]);
  });

  it('never returns the instant it was asked from', () => {
    const [first] = nextRuns(cron('* * * * *'), at('2026-10-16T10:00:30Z'), 1);
    expect(first?.toISOString()).toBe('2026-10-16T10:01:00.000Z');
  });

  it('handles steps, lists and ranges', () => {
    expect(iso(nextRuns(cron('*/20 8-9 * * *'), at('2026-10-16T00:00:00Z'), 4))).toEqual([
      '2026-10-16T08:00:00.000Z',
      '2026-10-16T08:20:00.000Z',
      '2026-10-16T08:40:00.000Z',
      '2026-10-16T09:00:00.000Z',
    ]);
  });

  it('runs weekly on the chosen weekday', () => {
    // 2026-10-16 is a Friday; Monday is 1.
    expect(iso(nextRuns(cron('0 3 * * mon'), at('2026-10-16T00:00:00Z'), 2))).toEqual([
      '2026-10-19T03:00:00.000Z',
      '2026-10-26T03:00:00.000Z',
    ]);
  });

  it('runs monthly and skips months that lack the day', () => {
    expect(iso(nextRuns(cron('0 0 31 * *'), at('2026-10-16T00:00:00Z'), 3))).toEqual([
      '2026-10-31T00:00:00.000Z',
      '2026-12-31T00:00:00.000Z',
      '2027-01-31T00:00:00.000Z',
    ]);
  });

  it('treats day-of-month and day-of-week as either-or when both are given', () => {
    // The 1st, or any Monday.
    const runs = iso(nextRuns(cron('0 0 1 * 1'), at('2026-10-16T00:00:00Z'), 3));
    expect(runs).toEqual([
      '2026-10-19T00:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ]);
  });

  it('treats a starred day field as no restriction', () => {
    const runs = iso(nextRuns(cron('0 0 * * 1'), at('2026-10-16T00:00:00Z'), 2));
    expect(runs).toEqual(['2026-10-19T00:00:00.000Z', '2026-10-26T00:00:00.000Z']);
  });

  it('finds 29 February, and gives up on a date that never exists', () => {
    expect(iso(nextRuns(cron('0 0 29 2 *'), at('2026-10-16T00:00:00Z'), 1))).toEqual([
      '2028-02-29T00:00:00.000Z',
    ]);
    expect(nextRuns(cron('0 0 31 2 *'), at('2026-10-16T00:00:00Z'), 5)).toEqual([]);
  });

  it('expands the descriptors', () => {
    expect(iso(nextRuns(cron('@weekly'), at('2026-10-16T00:00:00Z'), 1))).toEqual([
      '2026-10-18T00:00:00.000Z',
    ]);
    expect(iso(nextRuns(cron('@hourly'), at('2026-10-16T10:15:00Z'), 2))).toEqual([
      '2026-10-16T11:00:00.000Z',
      '2026-10-16T12:00:00.000Z',
    ]);
    expect(iso(nextRuns(cron('@yearly'), at('2026-10-16T00:00:00Z'), 1))).toEqual([
      '2027-01-01T00:00:00.000Z',
    ]);
  });

  it('spaces @every from the starting instant', () => {
    expect(iso(nextRuns(cron('@every 6h'), at('2026-10-16T00:00:00Z'), 2))).toEqual([
      '2026-10-16T06:00:00.000Z',
      '2026-10-16T12:00:00.000Z',
    ]);
  });

  it('crosses a year end', () => {
    expect(iso(nextRuns(cron('0 0 * * *'), at('2026-12-31T12:00:00Z'), 2))).toEqual([
      '2027-01-01T00:00:00.000Z',
      '2027-01-02T00:00:00.000Z',
    ]);
  });
});

describe('the builder patterns', () => {
  it.each([
    ['hourly', { minute: 15 }, '15 * * * *'],
    ['daily', { minute: 30, hour: 2 }, '30 2 * * *'],
    ['weekly', { minute: 0, hour: 3, weekday: 0 }, '0 3 * * 0'],
    ['monthly', { minute: 0, hour: 4, dayOfMonth: 15 }, '0 4 15 * *'],
  ] as const)('writes %s', (frequency, extra, expression) => {
    const pattern = { frequency, hour: 2, weekday: 1, dayOfMonth: 1, ...extra };
    expect(expressionFor(pattern)).toBe(expression);
    expect(patternOf(expression)).toMatchObject({ frequency, ...extra });
  });

  it.each([
    '*/5 * * * *',
    '0 2 * * 1-5',
    '@daily',
    '0 2 1 * 1',
    '61 * * * *',
    '0 25 * * *',
    '0 2 * * 7',
    'x',
  ])('calls %s custom', (expression) => {
    expect(patternOf(expression).frequency).toBe('custom');
  });
});
