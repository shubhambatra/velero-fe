import { describe, expect, it } from 'vitest';

import { policyBlocks } from './access.controller';

describe('what the agent policy blocks', () => {
  it('blocks nothing for a missing, malformed or permissive policy', () => {
    for (const policy of [
      null,
      undefined,
      'x',
      {},
      { readOnly: false, allowRestore: true, allowBslWrite: true },
    ]) {
      expect(policyBlocks(policy)).toEqual({});
    }
  });

  it('blocks every change but reading logs when read-only', () => {
    const blocked = policyBlocks({ readOnly: true });
    expect(Object.keys(blocked).sort()).toEqual([
      'advanced:write',
      'backup:create',
      'backup:delete',
      'restore:create',
      'restore:delete',
      'schedule:delete',
      'schedule:write',
      'storage:write',
    ]);
    expect(blocked['backup:create']).toMatch(/read-only/);
    expect(blocked['backup:logs']).toBeUndefined();
    expect(blocked['restore:logs']).toBeUndefined();
    expect(blocked['logs:read']).toBeUndefined();
  });

  it('blocks live logs when the policy turns streaming off, read-only or not', () => {
    expect(Object.keys(policyBlocks({ allowLogStreaming: false }))).toEqual(['logs:read']);
    expect(policyBlocks({ allowLogStreaming: false, readOnly: true })['logs:read']).toMatch(
      /does not allow streaming logs/,
    );
    expect(policyBlocks({ allowLogStreaming: true })).toEqual({});
  });

  it('blocks only restores, or only storage, when the policy says so', () => {
    expect(Object.keys(policyBlocks({ allowRestore: false }))).toEqual(['restore:create']);
    expect(Object.keys(policyBlocks({ allowBslWrite: false }))).toEqual(['storage:write']);
  });
});
