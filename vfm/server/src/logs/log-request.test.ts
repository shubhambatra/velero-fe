import { describe, expect, it } from 'vitest';

import { DEFAULT_TAIL_LINES, MAX_TAIL_LINES, startLogSessionBody } from './log-request';

const ok = { namespace: 'shop', pod: 'web-1' };

describe('a log session request', () => {
  it('fills in the defaults', () => {
    expect(startLogSessionBody.parse(ok)).toEqual({
      ...ok,
      tailLines: DEFAULT_TAIL_LINES,
      previous: false,
      timestamps: false,
    });
  });

  it.each([
    ['an uppercase namespace', { ...ok, namespace: 'Shop' }],
    ['a path in the pod', { ...ok, pod: '../etc/passwd' }],
    ['a newline in the container', { ...ok, container: 'app\nx' }],
    ['a namespace over 63 characters', { ...ok, namespace: 'a'.repeat(64) }],
    ['an empty pod', { ...ok, pod: '' }],
    ['too many tail lines', { ...ok, tailLines: MAX_TAIL_LINES + 1 }],
    ['negative tail lines', { ...ok, tailLines: -1 }],
    ['fractional since seconds', { ...ok, sinceSeconds: 1.5 }],
    ['zero since seconds', { ...ok, sinceSeconds: 0 }],
    ['a field nobody asked for', { ...ok, follow: false }],
  ])('refuses %s', (_name, body) => {
    expect(startLogSessionBody.safeParse(body).success).toBe(false);
  });
});
