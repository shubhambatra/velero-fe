import { describe, expect, it } from 'vitest';

import {
  SUPPORTED_VELERO_MINORS,
  VELERO_OLDEST_SUPPORTED,
  VELERO_PRIMARY,
  isSupportedVeleroVersion,
  veleroMinorOf,
} from './velero-support';

describe('veleroMinorOf', () => {
  it('extracts major.minor with and without the v prefix', () => {
    expect(veleroMinorOf('v1.18.4')).toBe('1.18');
    expect(veleroMinorOf('1.18.4')).toBe('1.18');
  });

  it('tolerates pre-release and build suffixes', () => {
    expect(veleroMinorOf('v1.18.0-rc.2')).toBe('1.18');
    expect(veleroMinorOf('v1.17.1+dirty')).toBe('1.17');
  });

  it('accepts a bare major.minor', () => {
    expect(veleroMinorOf('v1.16')).toBe('1.16');
  });

  it('trims surrounding whitespace, since the agent forwards server output verbatim', () => {
    expect(veleroMinorOf('  v1.18.4\n')).toBe('1.18');
  });

  it('returns null for anything it cannot parse', () => {
    for (const bad of ['', 'unknown', 'v1', 'latest', 'v.1.18', '1.18.x']) {
      expect(veleroMinorOf(bad), bad).toBeNull();
    }
  });
});

describe('isSupportedVeleroVersion', () => {
  it('accepts the pinned primary and the oldest supported release', () => {
    expect(isSupportedVeleroVersion(VELERO_PRIMARY)).toBe(true);
    expect(isSupportedVeleroVersion(VELERO_OLDEST_SUPPORTED)).toBe(true);
  });

  it('accepts every minor in the declared support window', () => {
    for (const minor of SUPPORTED_VELERO_MINORS) {
      expect(isSupportedVeleroVersion(`v${minor}.0`), minor).toBe(true);
    }
  });

  it('rejects versions outside the window', () => {
    expect(isSupportedVeleroVersion('v1.15.0')).toBe(false);
    expect(isSupportedVeleroVersion('v1.19.0')).toBe(false);
    expect(isSupportedVeleroVersion('v2.0.0')).toBe(false);
  });

  it('treats an unparseable version as unsupported rather than guessing', () => {
    expect(isSupportedVeleroVersion('unknown')).toBe(false);
    expect(isSupportedVeleroVersion('')).toBe(false);
  });
});

describe('support window declaration', () => {
  it('spans exactly three minors, newest first (PLAN.md §4.4)', () => {
    expect(SUPPORTED_VELERO_MINORS).toHaveLength(3);
    expect(SUPPORTED_VELERO_MINORS[0]).toBe(veleroMinorOf(VELERO_PRIMARY));
    expect(SUPPORTED_VELERO_MINORS[2]).toBe(veleroMinorOf(VELERO_OLDEST_SUPPORTED));
  });
});
