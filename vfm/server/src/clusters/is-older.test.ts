import { describe, expect, it } from 'vitest';

import { isOlder } from './clusters.service';

describe('isOlder (agent update available)', () => {
  it.each([
    ['0.1.0', '0.1.1', true],
    ['0.1.9', '0.2.0', true],
    ['0.9.9', '1.0.0', true],
    ['v0.1.0', '0.1.1', true],
    ['0.1.1', '0.1.1', false],
    ['0.2.0', '0.1.9', false],
    ['1.0.0', '0.9.9', false],
    ['0.1.1-rc.1', '0.1.1', false],
    ['0.10.0', '0.9.0', false],
  ])('%s vs %s -> %s', (have, expected, older) => {
    expect(isOlder(have, expected)).toBe(older);
  });

  it('never flags an agent that did not report, or reported something unparseable', () => {
    expect(isOlder(null, '1.0.0')).toBe(false);
    expect(isOlder('dev', '1.0.0')).toBe(false);
    expect(isOlder('1.0.0', 'garbage')).toBe(false);
  });
});
