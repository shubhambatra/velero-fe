import { describe, expect, it } from 'vitest';

import { ALERT_RULE_TYPES, parseParams, scopeSchema } from './rule-params';

describe('rule params', () => {
  it.each(ALERT_RULE_TYPES)('gives %s its defaults from nothing', (type) => {
    const result = parseParams(type, undefined);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.renotifyMinutes).toBe(240);
  });

  it('refuses an unknown key, a wrong type and a value out of range', () => {
    expect(parseParams('AGENT_DISCONNECTED', { minute: 5 }).ok).toBe(false);
    expect(parseParams('AGENT_DISCONNECTED', { minutes: '5' }).ok).toBe(false);
    expect(parseParams('AGENT_DISCONNECTED', { minutes: 0 }).ok).toBe(false);
    expect(parseParams('SCHEDULE_MISSED', { factor: 0.5 }).ok).toBe(false);
    expect(parseParams('BACKUP_FAILED', { lookbackHours: 100_000 }).ok).toBe(false);
    expect(parseParams('BSL_UNAVAILABLE', { minutes: 5 }).ok).toBe(false);
  });

  it('keeps what is given', () => {
    const result = parseParams('BACKUP_EXPIRING', { withinDays: 7, renotifyMinutes: 0 });
    expect(result).toEqual({ ok: true, value: { withinDays: 7, renotifyMinutes: 0 } });
  });

  it('scopes to clusters by id only', () => {
    expect(scopeSchema.safeParse({}).data).toEqual({ clusterIds: [] });
    expect(scopeSchema.safeParse({ clusterIds: ['nope'] }).success).toBe(false);
    expect(scopeSchema.safeParse({ namespaces: ['a'] }).success).toBe(false);
  });
});
