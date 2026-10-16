import { describe, expect, it } from 'vitest';

import { cronProblem } from './cron';
import {
  buildCreateSchedule,
  buildSetSchedulePaused,
  buildUpdateSchedule,
  checkSchedule,
  createScheduleBody,
  templateCoverage,
  updateScheduleBody,
} from './schedule-request';

describe('cron expressions', () => {
  it.each([
    '* * * * *',
    '0 2 * * *',
    '*/15 0-6 1,15 jan-mar mon-fri',
    '0 0 ? * sun',
    '@hourly',
    '@every 90m',
    '  5 4 * * 0  ',
    '0 0 31 12 6',
  ])('accepts %j', (expr) => {
    expect(cronProblem(expr)).toBeUndefined();
  });

  it.each([
    ['', 'required'],
    ['* * * *', 'five fields'],
    ['* * * * * *', 'five fields'],
    ['60 * * * *', 'minute'],
    ['* 24 * * *', 'hour'],
    ['* * 0 * *', 'day of month'],
    ['* * * 13 *', 'month'],
    ['* * * * 7', 'day of week'],
    ['*/0 * * * *', 'step'],
    ['5-1 * * * *', 'backwards'],
    ['a * * * *', 'minute'],
    ['1,,2 * * * *', 'empty'],
    ['1/2/3 * * * *', 'more than one step'],
    ['? * * * *', 'minute'],
    ['@sometimes', 'descriptor'],
    ['@every 0s', '@every'],
    ['@every banana', '@every'],
  ])('refuses %j', (expr, mention) => {
    expect(cronProblem(expr)).toContain(mention);
  });
});

describe('schedule bodies', () => {
  const ok = { name: 'nightly', schedule: '0 2 * * *', template: { includedNamespaces: ['dev'] } };

  it('are strict at every level', () => {
    expect(createScheduleBody.safeParse(ok).success).toBe(true);
    expect(createScheduleBody.safeParse({ ...ok, nope: 1 }).success).toBe(false);
    expect(createScheduleBody.safeParse({ ...ok, template: { nope: 1 } }).success).toBe(false);
    // The template is a backup without a name or an escape hatch of its own.
    expect(createScheduleBody.safeParse({ ...ok, template: { name: 'x' } }).success).toBe(false);
    expect(
      createScheduleBody.safeParse({ ...ok, template: { advancedSpec: { a: 1 } } }).success,
    ).toBe(false);
  });

  it('keep the name short enough for the backups the schedule will make', () => {
    expect(createScheduleBody.safeParse({ ...ok, name: 'a'.repeat(48) }).success).toBe(true);
    expect(createScheduleBody.safeParse({ ...ok, name: 'a'.repeat(49) }).success).toBe(false);
    expect(createScheduleBody.safeParse({ ...ok, name: 'Not_Valid' }).success).toBe(false);
  });

  it('check the cron and the template durations', () => {
    expect(
      checkSchedule(updateScheduleBody.parse({ schedule: ok.schedule, template: ok.template })),
    ).toBeUndefined();
    expect(checkSchedule(updateScheduleBody.parse({ schedule: 'daily', template: {} }))).toMatch(
      /^schedule: /,
    );
    expect(
      checkSchedule(updateScheduleBody.parse({ schedule: '@daily', template: { ttl: '0s' } })),
    ).toMatch(/ttl/);
  });

  it('become the protobuf the agent receives', () => {
    const arm = buildCreateSchedule({
      ...ok,
      paused: true,
      skipImmediately: false,
      template: { includedNamespaces: ['dev'], ttl: '72h' },
      advancedSpec: { hooks: {} },
    }).createSchedule;
    expect(arm?.name).toBe('nightly');
    expect(arm?.spec).toMatchObject({
      schedule: '0 2 * * *',
      paused: true,
      skipImmediately: false,
      template: { includedNamespaces: ['dev'], ttl: { seconds: 259200 } },
    });
    expect(arm?.spec?.useOwnerReferencesInBackup).toBeUndefined();
    expect(JSON.parse(Buffer.from(arm?.advancedSpecJson ?? []).toString())).toEqual({ hooks: {} });
  });

  it('build update and pause commands from stored payloads, and re-validate them', () => {
    expect(
      buildUpdateSchedule({ name: 'nightly', schedule: '@daily', template: {} }).updateSchedule
        ?.name,
    ).toBe('nightly');
    expect(() => buildUpdateSchedule({ name: 'BAD', schedule: '@daily', template: {} })).toThrow();
    expect(buildSetSchedulePaused({ name: 'a', paused: true }).setSchedulePaused).toEqual({
      name: 'a',
      paused: true,
    });
    expect(() => buildSetSchedulePaused({ name: 'a', paused: 'yes' })).toThrow();
  });
});

describe('what a stored template reaches', () => {
  it('follows the rule for a backup made by hand', () => {
    expect(templateCoverage({ template: { includedNamespaces: ['dev'] } })).toEqual({
      namespaces: ['dev'],
      includesClusterScoped: true,
    });
    expect(
      templateCoverage({
        template: { includedNamespaces: ['dev'], includeClusterResources: false },
      }),
    ).toEqual({ namespaces: ['dev'], includesClusterScoped: false });
    expect(templateCoverage({})).toEqual({ namespaces: ['*'], includesClusterScoped: true });
    expect(templateCoverage(null)).toEqual({ namespaces: ['*'], includesClusterScoped: true });
  });
});
