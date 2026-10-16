import { describe, expect, it } from 'vitest';

import {
  emptyRestoreForm,
  impactRows,
  impactTargets,
  parseMapping,
  toBody,
  toCli,
  validate,
  type RestoreForm,
} from './restore-form';

const open = { limitedToNamespaces: false, mayUseAdvanced: true };
const limited = { limitedToNamespaces: true, mayUseAdvanced: false };
const form = (over: Partial<RestoreForm> = {}): RestoreForm => ({
  ...emptyRestoreForm(false, 'nightly-1'),
  ...over,
});

describe('parseMapping', () => {
  it('reads source:target pairs', () => {
    expect(parseMapping('shop:shop-restored, cart:cart2')).toEqual({
      value: { shop: 'shop-restored', cart: 'cart2' },
    });
    expect(parseMapping('')).toEqual({ value: {} });
  });
  it.each(['shop', 'a:b:c', 'a:', ':b', 'A:b', 'a:B', 'a:*', 'a:b,a:c'])('refuses %s', (text) => {
    expect('error' in parseMapping(text)).toBe(true);
  });
});

describe('validate', () => {
  it('needs a source', () => {
    expect(validate(form({ source: '' }), open).source).toBeTruthy();
    expect(validate(form({ source: '', sourceKind: 'schedule' }), open).source).toMatch(/schedule/);
    expect(validate(form(), open)).toEqual({});
  });

  it.each([
    ['a bad name', { name: 'Bad Name' }, 'name'],
    ['a namespace glob', { namespaces: 'dev*' }, 'namespaces'],
    ['a bad mapping', { namespaces: 'a', mapping: 'a' }, 'mapping'],
    [
      'a mapping for a namespace that is not restored',
      { namespaces: 'a', mapping: 'b:c' },
      'mapping',
    ],
    ['a bad selector', { selector: 'a b' }, 'selector'],
    ['a bad timeout', { itemOperationTimeout: 'soon' }, 'itemOperationTimeout'],
    ['a zero timeout', { itemOperationTimeout: '0s' }, 'itemOperationTimeout'],
    ['too many downloads', { parallelFilesDownload: '100' }, 'parallelFilesDownload'],
    ['a bad modifier name', { resourceModifier: 'Bad' }, 'resourceModifier'],
    ['advanced that is not JSON', { advanced: '{' }, 'advanced'],
  ])('flags %s', (_name, over, field) => {
    expect(
      validate(form(over as Partial<RestoreForm>), open)[field as keyof RestoreForm],
    ).toBeTruthy();
  });

  it('lets a mapping stand when all namespaces are restored', () => {
    expect(validate(form({ mapping: 'a:b' }), open).mapping).toBeUndefined();
  });

  describe('for a user limited to some namespaces', () => {
    it('requires named namespaces and cluster-scoped resources off', () => {
      expect(validate(form({ clusterScoped: 'no' }), limited).namespaces).toBeTruthy();
      expect(
        validate(form({ clusterScoped: 'no', namespaces: '*' }), limited).namespaces,
      ).toBeTruthy();
      expect(
        validate(form({ clusterScoped: 'auto', namespaces: 'dev' }), limited).clusterScoped,
      ).toBeTruthy();
      expect(
        validate(form({ clusterScoped: 'no', namespaces: 'dev', mapping: 'dev:qa' }), limited),
      ).toEqual({});
    });
    it('starts with cluster-scoped resources off, and cannot use the advanced field', () => {
      expect(emptyRestoreForm(true).clusterScoped).toBe('no');
      expect(
        validate(form({ clusterScoped: 'no', namespaces: 'dev', advanced: '{}' }), limited)
          .advanced,
      ).toBeTruthy();
    });
  });
});

describe('toBody', () => {
  it('sends only the source for an untouched form', () => {
    expect(toBody(form())).toEqual({ backupName: 'nightly-1' });
    expect(toBody(form({ sourceKind: 'schedule', source: 'nightly' }))).toEqual({
      scheduleName: 'nightly',
    });
  });

  it('sends exactly what was set', () => {
    expect(
      toBody(
        form({
          name: ' r1 ',
          namespaces: 'shop, cart',
          excludeNamespaces: 'tmp',
          mapping: 'shop:shop-restored',
          includeResources: 'pods',
          excludeResources: 'events',
          clusterScoped: 'no',
          selector: 'app=web',
          orSelectors: 'a=b\nc=d',
          existingResourcePolicy: 'update',
          restorePVs: 'no',
          preserveNodePorts: 'yes',
          statusInclude: 'workflows',
          itemOperationTimeout: '2h',
          resourceModifier: 'mods',
          writeSparseFiles: 'yes',
          parallelFilesDownload: '3',
          advanced: '{"hooks":{"resources":[]}}',
        }),
      ),
    ).toEqual({
      backupName: 'nightly-1',
      name: 'r1',
      includedNamespaces: ['shop', 'cart'],
      excludedNamespaces: ['tmp'],
      namespaceMapping: { shop: 'shop-restored' },
      includedResources: ['pods'],
      excludedResources: ['events'],
      includeClusterResources: false,
      labelSelector: { matchLabels: { app: 'web' } },
      orLabelSelectors: [{ matchLabels: { a: 'b' } }, { matchLabels: { c: 'd' } }],
      existingResourcePolicy: 'update',
      restorePVs: false,
      preserveNodePorts: true,
      restoreStatus: { includedResources: ['workflows'] },
      itemOperationTimeout: '2h',
      resourceModifier: 'mods',
      writeSparseFiles: true,
      parallelFilesDownload: 3,
      advancedSpec: { hooks: { resources: [] } },
    });
  });

  it('leaves Velero’s defaults alone', () => {
    const body = toBody(form({ clusterScoped: 'auto' }));
    for (const key of [
      'includeClusterResources',
      'restorePVs',
      'existingResourcePolicy',
      'restoreStatus',
    ]) {
      expect(key in body).toBe(false);
    }
  });
});

describe('toCli', () => {
  it('names the source flag after the kind', () => {
    expect(toCli(form()).command).toBe('velero restore create <name> --from-backup nightly-1');
    expect(toCli(form({ sourceKind: 'schedule', source: 'nightly' })).command).toBe(
      'velero restore create <name> --from-schedule nightly',
    );
    expect(toCli(form({ source: '' })).command).toBe(
      'velero restore create <name> --from-backup <source>',
    );
  });

  it('writes every flag the form can set', () => {
    expect(
      toCli(
        form({
          name: 'r1',
          namespaces: 'shop,cart',
          excludeNamespaces: 'tmp',
          mapping: 'shop:shop-restored,cart:cart2',
          includeResources: 'pods',
          excludeResources: 'events',
          clusterScoped: 'no',
          selector: 'app=web,tier in (a,b)',
          orSelectors: 'a=b\nc=d',
          existingResourcePolicy: 'update',
          restorePVs: 'no',
          preserveNodePorts: 'yes',
          statusInclude: 'workflows',
          statusExclude: 'jobs',
          itemOperationTimeout: '2h',
          resourceModifier: 'mods',
          writeSparseFiles: 'yes',
          parallelFilesDownload: '3',
        }),
      ).command,
    ).toBe(
      "velero restore create r1 --from-backup nightly-1 --include-namespaces shop,cart --exclude-namespaces tmp --namespace-mappings shop:shop-restored,cart:cart2 --include-resources pods --exclude-resources events --include-cluster-resources=false --selector 'app=web,tier in (a,b)' --or-selector 'a=b or c=d' --existing-resource-policy update --restore-volumes=false --preserve-nodeports=true --status-include-resources workflows --status-exclude-resources jobs --item-operation-timeout 2h --resource-modifier-configmap mods --write-sparse-files=true --parallel-files-download 3",
    );
  });

  it('says what has no flag', () => {
    expect(toCli(form({ advanced: '{"a":1}' })).notes).toHaveLength(1);
  });
});

describe('the impact summary', () => {
  const report = [
    { name: 'shop', exists: true, terminating: false },
    { name: 'fresh', exists: false, terminating: false },
    { name: 'going', exists: true, terminating: true },
  ];

  it('has nothing to list when every namespace is restored', () => {
    expect(impactTargets(form())).toBeNull();
    expect(impactTargets(form({ namespaces: '*' }))).toBeNull();
    expect(impactRows(form(), report)).toBeNull();
  });

  it('works out the target of each namespace, mapped or in place', () => {
    expect(impactTargets(form({ namespaces: 'shop,cart', mapping: 'shop:fresh' }))).toEqual([
      { source: 'shop', target: 'fresh' },
      { source: 'cart', target: 'cart' },
    ]);
  });

  it('is safe for a namespace named like an object property', () => {
    expect(impactTargets(form({ namespaces: 'constructor' }))).toEqual([
      { source: 'constructor', target: 'constructor' },
    ]);
  });

  it('says what will happen in each, by what the cluster reports', () => {
    const rows =
      impactRows(form({ namespaces: 'a,b,c', mapping: 'a:shop,b:fresh,c:going' }), report) ?? [];
    expect(rows.map((r) => [r.target, r.effect, r.inPlace])).toEqual([
      ['shop', 'merged', false],
      ['fresh', 'created', false],
      ['going', 'blocked', false],
    ]);
  });

  it('says "updated" when the policy is to update, and "unknown" before the agent answers', () => {
    expect(
      impactRows(form({ namespaces: 'shop', existingResourcePolicy: 'update' }), report)?.[0]
        ?.effect,
    ).toBe('updated');
    const before = impactRows(form({ namespaces: 'shop' }), undefined) ?? [];
    expect(before[0]).toMatchObject({ effect: 'unknown', inPlace: true });
  });

  it('treats an unreported target as unknown, never as absent', () => {
    expect(impactRows(form({ namespaces: 'other' }), report)?.[0]?.effect).toBe('unknown');
  });
});
