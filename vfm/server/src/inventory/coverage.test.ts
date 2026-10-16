import { describe, expect, it } from 'vitest';

import { coverageOf, coversNamespace, STALE_AFTER_MS } from './coverage';

const now = new Date('2026-10-17T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const H = 3_600_000;

describe('which namespaces a spec covers', () => {
  it.each([
    ['no filter means everything', {}, 'shop', true],
    ['a star means everything', { includedNamespaces: ['*'] }, 'shop', true],
    ['a named namespace', { includedNamespaces: ['shop', 'cart'] }, 'cart', true],
    ['another namespace', { includedNamespaces: ['shop'] }, 'cart', false],
    ['everything but an excluded one', { excludedNamespaces: ['cart'] }, 'cart', false],
    ['everything but an excluded one, for another', { excludedNamespaces: ['cart'] }, 'shop', true],
    [
      'an exclusion beats an inclusion',
      { includedNamespaces: ['shop'], excludedNamespaces: ['shop'] },
      'shop',
      false,
    ],
    ['garbage covers all, as Velero would read it', { includedNamespaces: 'shop' }, 'shop', true],
    ['not an object', null, 'shop', true],
  ])('%s', (_name, spec, ns, want) => {
    expect(coversNamespace(spec, ns)).toBe(want);
  });
});

describe('coverage of a namespace', () => {
  const backups = [
    { name: 'wide-new', spec: { excludedNamespaces: ['shop'] }, completedAt: ago(1 * H) },
    { name: 'shop-old', spec: { includedNamespaces: ['shop'] }, completedAt: ago(100 * H) },
    { name: 'shop-older', spec: { includedNamespaces: ['shop'] }, completedAt: ago(200 * H) },
  ];

  it('takes the newest successful backup that covers it', () => {
    expect(coverageOf('cart', backups, [], now)).toMatchObject({
      state: 'recent',
      lastBackupName: 'wide-new',
    });
    // The newest one excludes shop, so the next that covers it is used, and it is stale.
    expect(coverageOf('shop', backups, [], now)).toMatchObject({
      state: 'stale',
      lastBackupName: 'shop-old',
    });
  });

  it('is recent up to the threshold and stale beyond it', () => {
    const at = (ms: number) => [{ name: 'b', spec: {}, completedAt: ago(ms) }];
    expect(coverageOf('x', at(STALE_AFTER_MS), [], now).state).toBe('recent');
    expect(coverageOf('x', at(STALE_AFTER_MS + 1), [], now).state).toBe('stale');
  });

  it('says none when nothing covers it', () => {
    expect(coverageOf('billing', backups.slice(1, 2), [], now)).toEqual({
      state: 'none',
      lastBackupAt: null,
      lastBackupName: null,
      scheduled: false,
    });
  });

  it('withholds a backup’s name from someone who may not see that backup, but still reports the time', () => {
    const out = coverageOf('cart', backups, [], now, () => false);
    expect(out.lastBackupName).toBeNull();
    expect(out.lastBackupAt).toEqual(ago(1 * H));
  });

  it('notes an enabled schedule that covers it, and ignores a paused one', () => {
    const schedules = [
      { spec: { paused: true, template: { includedNamespaces: ['shop'] } } },
      { spec: { template: { includedNamespaces: ['cart'] } } },
    ];
    expect(coverageOf('shop', [], schedules, now).scheduled).toBe(false);
    expect(coverageOf('cart', [], schedules, now).scheduled).toBe(true);
  });

  it('ignores a backup that has not completed', () => {
    expect(coverageOf('x', [{ name: 'b', spec: {}, completedAt: null }], [], now).state).toBe(
      'none',
    );
  });
});
