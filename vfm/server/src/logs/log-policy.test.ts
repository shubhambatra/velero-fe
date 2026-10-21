import { describe, expect, it } from 'vitest';

import { logPolicyDenial } from './log-policy';

describe('what the agent policy says about streaming logs', () => {
  it('allows when the policy is missing, malformed or permissive', () => {
    for (const policy of [
      null,
      undefined,
      'x',
      5,
      {},
      { allowLogStreaming: true },
      { logStreamDeniedNamespaces: 'shop' },
      { logStreamDeniedNamespaces: [] },
    ]) {
      expect(logPolicyDenial(policy, 'shop')).toBeUndefined();
    }
  });

  it('refuses everything when streaming is off', () => {
    expect(logPolicyDenial({ allowLogStreaming: false }, 'shop')).toMatch(/does not allow/);
  });

  it('refuses a denied namespace, by name and by wildcard, and only that one', () => {
    const policy = { logStreamDeniedNamespaces: ['kube-system', 'payments'] };
    expect(logPolicyDenial(policy, 'payments')).toMatch(/“payments”/);
    expect(logPolicyDenial(policy, 'shop')).toBeUndefined();
    expect(logPolicyDenial({ logStreamDeniedNamespaces: ['*'] }, 'shop')).toBeDefined();
  });
});
