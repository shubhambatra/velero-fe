import { describe, expect, it } from 'vitest';

import { ExistingResourcePolicy } from '../gateway/pb/vfm/agent/v1/velero';
import {
  buildCreateRestore,
  checkRestoreDurations,
  createRestoreBody,
  restoreCoverage,
  toRestoreSpec,
} from './restore-request';

const parse = (over: object) => createRestoreBody.safeParse({ backupName: 'b', ...over });

describe('restoreCoverage: who may make a restore (PLAN.md §8.2)', () => {
  it.each([
    ['no namespaces', {}, ['*']],
    ['an empty list', { includedNamespaces: [] }, ['*']],
    ['the wildcard', { includedNamespaces: ['*'] }, ['*']],
    ['named namespaces', { includedNamespaces: ['dev', 'qa'] }, ['dev', 'qa']],
  ])('%s', (_name, input, namespaces) => {
    expect(restoreCoverage(input).namespaces).toEqual(namespaces);
  });

  it('counts both sides of a mapping', () => {
    expect(
      restoreCoverage({
        includedNamespaces: ['prod'],
        namespaceMapping: { prod: 'dev' },
      }).namespaces.sort(),
    ).toEqual(['dev', 'prod']);
  });

  it('ignores a mapping for a namespace that is not restored', () => {
    expect(
      restoreCoverage({ includedNamespaces: ['dev'], namespaceMapping: { prod: 'other' } })
        .namespaces,
    ).toEqual(['dev']);
  });

  it('does not let a mapping hide an "all namespaces" restore', () => {
    expect(restoreCoverage({ namespaceMapping: { prod: 'dev' } }).namespaces).toEqual(['*']);
  });

  it('is safe for a namespace named like an object property', () => {
    expect(
      restoreCoverage({ includedNamespaces: ['constructor'], namespaceMapping: {} }).namespaces,
    ).toEqual(['constructor']);
  });

  it.each([
    ['unset', undefined, true],
    ['true', true, true],
    ['false', false, false],
  ])('cluster-scoped resources when includeClusterResources is %s', (_n, value, expected) => {
    expect(restoreCoverage({ includeClusterResources: value }).includesClusterScoped).toBe(
      expected,
    );
  });
});

describe('the restore body', () => {
  it('accepts a full set of flags', () => {
    expect(
      parse({
        name: 'r1',
        includedNamespaces: ['shop'],
        excludedNamespaces: ['tmp'],
        includedResources: ['pods'],
        excludedResources: ['events'],
        namespaceMapping: { shop: 'shop-restored' },
        labelSelector: { matchLabels: { app: 'web' } },
        orLabelSelectors: [{ matchLabels: { a: 'b' } }],
        restorePVs: false,
        restoreStatus: { includedResources: ['workflows'] },
        preserveNodePorts: true,
        includeClusterResources: false,
        existingResourcePolicy: 'update',
        itemOperationTimeout: '2h',
        resourceModifier: 'mods',
        writeSparseFiles: true,
        parallelFilesDownload: 4,
      }).success,
    ).toBe(true);
  });

  it('needs exactly one source', () => {
    expect(createRestoreBody.safeParse({}).success).toBe(false);
    expect(createRestoreBody.safeParse({ backupName: 'b', scheduleName: 's' }).success).toBe(false);
    expect(createRestoreBody.safeParse({ scheduleName: 's' }).success).toBe(true);
  });

  it.each([
    ['an unknown field', { nope: 1 }],
    ['hooks (only through advancedSpec)', { hooks: {} }],
    ['a mapping to a glob', { namespaceMapping: { a: 'b*' } }],
    ['a mapping from the wildcard', { namespaceMapping: { '*': 'b' } }],
    ['a mapping to the wildcard', { namespaceMapping: { a: '*' } }],
    ['an upper-case mapping target', { namespaceMapping: { a: 'B' } }],
    ['an unknown existing-resource policy', { existingResourcePolicy: 'merge' }],
    ['a bad duration', { itemOperationTimeout: 'soon' }],
    ['too many downloads', { parallelFilesDownload: 1000 }],
    ['a bad backup name', { backupName: 'Bad Name' }],
    ['an unknown field in restoreStatus', { restoreStatus: { all: true } }],
  ])('refuses %s', (_name, over) => {
    expect(parse(over).success).toBe(false);
  });

  it('refuses a body that has the right source but a wrong type', () => {
    expect(parse({ restorePVs: 'no' }).success).toBe(false);
  });

  it('rejects durations out of range with a message', () => {
    expect(
      checkRestoreDurations(
        createRestoreBody.parse({ backupName: 'b', itemOperationTimeout: '0s' }),
      ),
    ).toMatch(/greater than zero/);
    expect(
      checkRestoreDurations(
        createRestoreBody.parse({ backupName: 'b', itemOperationTimeout: '999999h' }),
      ),
    ).toMatch(/ten years/);
    expect(checkRestoreDurations(createRestoreBody.parse({ backupName: 'b' }))).toBeUndefined();
  });
});

describe('the protobuf the agent receives', () => {
  it('carries every flag, with unset booleans left unset', () => {
    const spec = toRestoreSpec(
      createRestoreBody.parse({
        scheduleName: 'nightly',
        includedNamespaces: ['shop'],
        namespaceMapping: { shop: 'shop-restored' },
        restorePVs: false,
        existingResourcePolicy: 'none',
        itemOperationTimeout: '2h',
        resourceModifier: 'mods',
        parallelFilesDownload: 3,
      }),
    );
    expect(spec.scheduleName).toBe('nightly');
    expect(spec.backupName).toBe('');
    expect(spec.namespaceMapping).toEqual({ shop: 'shop-restored' });
    expect(spec.restorePvs).toBe(false);
    expect(spec.preserveNodePorts).toBeUndefined();
    expect(spec.includeClusterResources).toBeUndefined();
    expect(spec.existingResourcePolicy).toBe(ExistingResourcePolicy.EXISTING_RESOURCE_POLICY_NONE);
    expect(spec.itemOperationTimeout).toEqual({ seconds: 7200, nanos: 0 });
    expect(spec.resourceModifier).toEqual({ apiGroup: '', kind: 'ConfigMap', name: 'mods' });
    expect(spec.uploaderConfig).toEqual({ writeSparseFiles: undefined, parallelFilesDownload: 3 });
    expect(spec.hooks).toBeUndefined();
  });

  it('leaves the policy unspecified when none is chosen', () => {
    expect(toRestoreSpec(createRestoreBody.parse({ backupName: 'b' })).existingResourcePolicy).toBe(
      ExistingResourcePolicy.EXISTING_RESOURCE_POLICY_UNSPECIFIED,
    );
  });

  it('re-validates a stored payload', () => {
    expect(buildCreateRestore({ backupName: 'b', name: 'r' }).createRestore?.name).toBe('r');
    expect(() => buildCreateRestore({ bogus: 1 })).toThrow();
    expect(() => buildCreateRestore({})).toThrow();
  });
});
