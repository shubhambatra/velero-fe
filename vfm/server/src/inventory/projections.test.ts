import { describe, expect, it } from 'vitest';

import {
  backupSummary,
  coveredBy,
  locationSummary,
  restoreSummary,
  scheduleSummary,
  timeline,
} from './projections';

const row = (over: Record<string, unknown> = {}) => ({
  name: 'n',
  phase: 'Completed',
  startedAt: new Date('2026-10-16T01:00:00Z'),
  completedAt: new Date('2026-10-16T01:03:00Z'),
  expiresAt: new Date('2026-11-15T01:00:00Z'),
  createdByVfm: false,
  creationTimestamp: new Date('2026-10-16T00:59:59Z'),
  labels: {},
  spec: {},
  status: {},
  ...over,
});

describe('coveredBy: what an object touches, for who may see it', () => {
  it.each([
    ['a named list', { includedNamespaces: ['dev', 'qa'] }, ['dev', 'qa']],
    ['no list at all', {}, ['*']],
    ['an empty list', { includedNamespaces: [] }, ['*']],
    ['a wildcard anywhere in the list', { includedNamespaces: ['dev', '*'] }, ['*']],
    [
      'a list plus excludes: excludes never narrow it',
      { includedNamespaces: [], excludedNamespaces: ['prod'] },
      ['*'],
    ],
    ['non-string junk', { includedNamespaces: [1, null, 'dev', {}] }, ['dev']],
    ['something that is not a list', { includedNamespaces: 'dev' }, ['*']],
  ])('a backup with %s', (_name, spec, expected) => {
    expect(coveredBy('BACKUP', spec).namespaces).toEqual(expected);
  });

  it('counts explicit cluster-scoped inclusion, and ignores Velero’s automatic kind', () => {
    expect(coveredBy('BACKUP', { includeClusterResources: true }).includesClusterScoped).toBe(true);
    expect(
      coveredBy('BACKUP', { includedClusterScopedResources: ['pv'] }).includesClusterScoped,
    ).toBe(true);
    expect(coveredBy('BACKUP', { includeClusterResources: false }).includesClusterScoped).toBe(
      false,
    );
    expect(coveredBy('BACKUP', {}).includesClusterScoped).toBe(false);
    expect(coveredBy('BACKUP', { includedClusterScopedResources: [] }).includesClusterScoped).toBe(
      false,
    );
  });

  it('counts both sides of a restore, source and mapped target', () => {
    expect(
      coveredBy('RESTORE', {
        includedNamespaces: ['prod'],
        namespaceMapping: { prod: 'dev' },
      }).namespaces.sort(),
    ).toEqual(['dev', 'prod']);
  });

  it('is not fooled by a mapping key that is a prototype property', () => {
    expect(
      coveredBy('RESTORE', { includedNamespaces: ['constructor'], namespaceMapping: { x: 'y' } })
        .namespaces,
    ).toEqual(['constructor']);
  });

  it('reads a schedule through its template', () => {
    expect(coveredBy('SCHEDULE', { template: { includedNamespaces: ['dev'] } }).namespaces).toEqual(
      ['dev'],
    );
    expect(coveredBy('SCHEDULE', {}).namespaces).toEqual(['*']);
  });

  it('survives anything an agent could put in spec', () => {
    for (const spec of [null, undefined, 5, 'x', [], [1], { includedNamespaces: { a: 1 } }]) {
      expect(() => coveredBy('BACKUP', spec)).not.toThrow();
      expect(() => coveredBy('RESTORE', spec)).not.toThrow();
      expect(() => coveredBy('SCHEDULE', spec)).not.toThrow();
    }
  });

  it('has no namespace opinion about storage', () => {
    expect(coveredBy('BACKUP_STORAGE_LOCATION', {})).toEqual({
      namespaces: [],
      includesClusterScoped: false,
    });
  });
});

describe('summaries', () => {
  it('describes a backup and bounds what it shows', () => {
    const s = backupSummary(
      row({
        labels: { 'velero.io/schedule-name': 'nightly' },
        spec: {
          storageLocation: 'default',
          ttl: '720h0m0s',
          includedNamespaces: Array.from({ length: 25 }, (_, i) => `ns${i.toString()}`),
        },
        status: {
          warnings: 2,
          errors: 1,
          progress: { itemsBackedUp: 10, totalItems: 12 },
          volumeSnapshotsAttempted: 3,
          volumeSnapshotsCompleted: 2,
        },
      }),
    );
    expect(s).toMatchObject({
      schedule: 'nightly',
      storageLocation: 'default',
      warnings: 2,
      errors: 1,
      itemsBackedUp: 10,
      totalItems: 12,
      volumeSnapshots: { attempted: 3, completed: 2 },
    });
    expect(s.scope.namespaces).toHaveLength(10);
    expect(s.scope.more).toBe(15);
    expect(s.scope.all).toBe(false);
  });

  it('shows "all namespaces" rather than listing a wildcard', () => {
    expect(backupSummary(row()).scope).toEqual({ all: true, namespaces: [], more: 0 });
  });

  it('describes a restore with its source backup', () => {
    expect(
      restoreSummary(
        row({
          spec: { backupName: 'b1', existingResourcePolicy: 'update' },
          status: { warnings: 1 },
        }),
      ),
    ).toMatchObject({
      backupName: 'b1',
      existingResourcePolicy: 'update',
      warnings: 1,
      errors: 0,
    });
  });

  it('describes a schedule, including that it is paused', () => {
    expect(
      scheduleSummary(
        row({
          spec: {
            schedule: '0 1 * * *',
            paused: true,
            template: { storageLocation: 'default', ttl: '24h' },
          },
          status: { lastBackup: '2026-10-16T01:00:00Z', validationErrors: ['bad'] },
        }),
      ),
    ).toMatchObject({
      cron: '0 1 * * *',
      paused: true,
      storageLocation: 'default',
      lastBackup: '2026-10-16T01:00:00Z',
      validationErrors: ['bad'],
    });
  });

  it('describes a storage location with only a reference to its credential', () => {
    const s = locationSummary(
      row({
        spec: {
          provider: 'aws',
          default: true,
          objectStorage: { bucket: 'b', prefix: 'p' },
          credential: { name: 'cloud-credentials', key: 'cloud', secretValue: 'LEAK' },
        },
        status: { phase: 'Available', message: 'ok', lastValidationTime: '2026-10-16T01:00:00Z' },
      }),
      'BACKUP_STORAGE_LOCATION',
    );
    expect(s).toMatchObject({
      provider: 'aws',
      isDefault: true,
      bucket: 'b',
      credential: { name: 'cloud-credentials', key: 'cloud' },
    });
    expect(JSON.stringify(s)).not.toContain('LEAK');
  });

  it('survives junk in every field', () => {
    const junk = row({ spec: 5, status: [1], labels: 'x' });
    expect(() => [
      backupSummary(junk),
      restoreSummary(junk),
      scheduleSummary(junk),
      locationSummary(junk, 'X'),
    ]).not.toThrow();
    expect(backupSummary(junk).warnings).toBe(0);
  });
});

describe('timeline', () => {
  it('orders the moments and names the outcome', () => {
    expect(timeline(row()).map((t) => t.event)).toEqual([
      'Created',
      'Started',
      'Finished: Completed',
      'Expires',
    ]);
  });

  it('leaves out moments that are not known', () => {
    expect(
      timeline(row({ startedAt: null, completedAt: null, expiresAt: null })).map((t) => t.event),
    ).toEqual(['Created']);
  });
});
