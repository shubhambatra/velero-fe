import { describe, expect, it } from 'vitest';

import {
  buildCreateBackup,
  checkDurations,
  createBackupBody,
  createCoverage,
  durationSeconds,
  toBackupSpec,
  triggerBody,
} from './backup-request';

describe('createCoverage: who may make a backup (PLAN.md §8.2)', () => {
  it.each([
    ['no namespaces', {}, ['*']],
    ['an empty list', { includedNamespaces: [] }, ['*']],
    ['the wildcard', { includedNamespaces: ['*'] }, ['*']],
    ['the wildcard among others', { includedNamespaces: ['dev', '*'] }, ['*']],
    ['named namespaces', { includedNamespaces: ['dev', 'qa'] }, ['dev', 'qa']],
  ])('%s', (_name, input, namespaces) => {
    expect(createCoverage(input).namespaces).toEqual(namespaces);
  });

  it.each([
    ['unset ("auto" in Velero)', {}, true],
    ['true', { includeClusterResources: true }, true],
    ['false', { includeClusterResources: false }, false],
    [
      'false but cluster-scoped kinds named',
      { includeClusterResources: false, includedClusterScopedResources: ['persistentvolumes'] },
      true,
    ],
    [
      'false and an empty cluster-scoped list',
      { includeClusterResources: false, includedClusterScopedResources: [] },
      false,
    ],
    ['unset but cluster-scoped kinds named', { includedClusterScopedResources: ['nodes'] }, true],
  ])('cluster-scoped resources when includeClusterResources is %s', (_name, input, expected) => {
    expect(createCoverage(input).includesClusterScoped).toBe(expected);
  });

  it('is not narrowed by exclusions or selectors, which the function never sees', () => {
    // Excluding prod from "everything" still reaches everything else.
    const body = createBackupBody.parse({
      excludedNamespaces: ['prod'],
      labelSelector: { matchLabels: { a: 'b' } },
    });
    expect(createCoverage(body)).toEqual({ namespaces: ['*'], includesClusterScoped: true });
  });
});

describe('the request body', () => {
  it('accepts a full set of flags', () => {
    const body = createBackupBody.parse({
      name: 'nightly-1',
      includedNamespaces: ['shop'],
      excludedNamespaces: ['tmp'],
      includedResources: ['pods'],
      excludedResources: ['events'],
      includedClusterScopedResources: [],
      labelSelector: {
        matchLabels: { app: 'web' },
        matchExpressions: [{ key: 'tier', operator: 'In', values: ['a'] }],
      },
      orLabelSelectors: [{ matchLabels: { a: 'b' } }],
      includeClusterResources: false,
      ttl: '720h',
      storageLocation: 'default',
      volumeSnapshotLocations: ['aws'],
      snapshotVolumes: true,
      defaultVolumesToFsBackup: false,
      snapshotMoveData: true,
      dataMover: 'velero',
      itemOperationTimeout: '4h',
      csiSnapshotTimeout: '10m',
      resourcePolicy: 'policy',
      orderedResources: { pods: 'shop/a,shop/b' },
      parallelFilesUpload: 4,
      metadataLabels: { team: 'shop' },
    });
    expect(body.name).toBe('nightly-1');
  });

  it.each([
    ['an unknown field', { includedNamespace: ['x'] }],
    ['hooks (only through advancedSpec)', { hooks: { resources: [] } }],
    ['a namespace glob', { includedNamespaces: ['dev*'] }],
    ['an upper-case namespace', { includedNamespaces: ['Dev'] }],
    ['a namespace with a slash', { includedNamespaces: ['a/b'] }],
    ['a bad name', { name: 'Bad Name' }],
    ['a name that is too long', { name: 'a'.repeat(64) }],
    ['a bad duration', { ttl: 'a month' }],
    ['a negative number of uploads', { parallelFilesUpload: 0 }],
    ['too many uploads', { parallelFilesUpload: 1000 }],
    ['a string for a boolean', { snapshotVolumes: 'yes' }],
    [
      'an unknown selector operator',
      { labelSelector: { matchExpressions: [{ key: 'a', operator: 'Like' }] } },
    ],
    ['an unknown field inside a selector', { labelSelector: { match: {} } }],
    [
      'more than 200 namespaces',
      { includedNamespaces: Array.from({ length: 201 }, (_, i) => `n${i.toString()}`) },
    ],
    ['a non-object advancedSpec', { advancedSpec: ['x'] }],
  ])('refuses %s', (_name, body) => {
    expect(createBackupBody.safeParse(body).success).toBe(false);
  });

  it('allows an empty body: a backup of everything, named by the agent', () => {
    expect(createBackupBody.safeParse({}).success).toBe(true);
  });

  it('keeps advancedSpec as given, for the agent to validate', () => {
    const body = createBackupBody.parse({
      advancedSpec: { hooks: { resources: [] }, anything: 1 },
    });
    expect(body.advancedSpec).toEqual({ hooks: { resources: [] }, anything: 1 });
  });

  it('refuses unknown fields on trigger too', () => {
    expect(triggerBody.safeParse({ backupName: 'x', also: 1 }).success).toBe(false);
    expect(triggerBody.safeParse({ backupName: 'Bad' }).success).toBe(false);
    expect(triggerBody.safeParse({}).success).toBe(true);
  });
});

describe('durations', () => {
  it.each([
    ['720h', 2_592_000, 0],
    ['1h30m', 5_400, 0],
    ['90s', 90, 0],
    ['1.5s', 1, 500_000_000],
    ['500ms', 0, 500_000_000],
  ])('%s', (text, seconds, nanos) => {
    expect(durationSeconds(text)).toEqual({ seconds, nanos });
  });

  it('treats zero as unset', () => {
    expect(durationSeconds('0s')).toBeUndefined();
  });

  it('rejects zero and absurd values with a message', () => {
    expect(checkDurations(createBackupBody.parse({ ttl: '0h' }))).toMatch(/ttl must be greater/);
    expect(checkDurations(createBackupBody.parse({ itemOperationTimeout: '999999h' }))).toMatch(
      /ten years/,
    );
    expect(
      checkDurations(createBackupBody.parse({ ttl: '720h', csiSnapshotTimeout: '5m' })),
    ).toBeUndefined();
  });
});

describe('the protobuf the agent receives', () => {
  it('carries every flag, with unset booleans left unset', () => {
    const spec = toBackupSpec(
      createBackupBody.parse({
        includedNamespaces: ['shop'],
        ttl: '72h',
        snapshotVolumes: false,
        resourcePolicy: 'policy',
        parallelFilesUpload: 4,
        labelSelector: { matchLabels: { app: 'web' } },
      }),
    );
    expect(spec.includedNamespaces).toEqual(['shop']);
    expect(spec.ttl).toEqual({ seconds: 259_200, nanos: 0 });
    expect(spec.snapshotVolumes).toBe(false);
    expect(spec.defaultVolumesToFsBackup).toBeUndefined();
    expect(spec.includeClusterResources).toBeUndefined();
    expect(spec.resourcePolicy).toEqual({ apiGroup: '', kind: 'ConfigMap', name: 'policy' });
    expect(spec.uploaderConfig).toEqual({ parallelFilesUpload: 4 });
    expect(spec.labelSelector?.matchLabels).toEqual({ app: 'web' });
    expect(spec.hooks).toBeUndefined();
  });

  it('re-validates a stored payload and puts advancedSpec in bytes', () => {
    const built = buildCreateBackup({ name: 'x', advancedSpec: { snapshotVolumes: true } });
    expect(built.createBackup?.name).toBe('x');
    expect(Buffer.from(built.createBackup?.advancedSpecJson ?? []).toString()).toBe(
      '{"snapshotVolumes":true}',
    );
    expect(() => buildCreateBackup({ bogus: 1 })).toThrow();
  });
});
