import { describe, expect, it } from 'vitest';

import {
  emptyForm,
  parseOrdered,
  parseSelector,
  selectorText,
  shellQuote,
  toBody,
  toCli,
  validate,
  type BackupForm,
} from './backup-form';

const open = { limitedToNamespaces: false, mayUseAdvanced: true };
const limited = { limitedToNamespaces: true, mayUseAdvanced: false };
const form = (over: Partial<BackupForm> = {}): BackupForm => ({ ...emptyForm(false), ...over });

describe('parseSelector', () => {
  it.each([
    ['app=web', { matchLabels: { app: 'web' } }],
    ['app==web, tier=db', { matchLabels: { app: 'web', tier: 'db' } }],
    ['tier in (a, b)', { matchExpressions: [{ key: 'tier', operator: 'In', values: ['a', 'b'] }] }],
    ['tier notin (a)', { matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['a'] }] }],
    ['env!=prod', { matchExpressions: [{ key: 'env', operator: 'NotIn', values: ['prod'] }] }],
    ['canary', { matchExpressions: [{ key: 'canary', operator: 'Exists' }] }],
    ['!legacy', { matchExpressions: [{ key: 'legacy', operator: 'DoesNotExist' }] }],
    [
      'app=web,tier in (a,b),!legacy',
      {
        matchLabels: { app: 'web' },
        matchExpressions: [
          { key: 'tier', operator: 'In', values: ['a', 'b'] },
          { key: 'legacy', operator: 'DoesNotExist' },
        ],
      },
    ],
    ['example.com/team=x', { matchLabels: { 'example.com/team': 'x' } }],
  ])('reads %s', (text, expected) => {
    expect(parseSelector(text)).toEqual({ selector: expected });
  });

  it.each(['app=we b', 'tier in ()', 'tier in (a b', '=x', 'a/b/c=1', 'bad key=1', '!'])(
    'refuses %s',
    (text) => {
      expect('error' in parseSelector(text)).toBe(true);
    },
  );

  it('writes a selector back so that reading it again gives the same selector', () => {
    for (const text of ['app=web,tier in (a,b),!legacy', 'env!=prod', 'canary']) {
      const parsed = parseSelector(text);
      if (!('selector' in parsed)) throw new Error('unreadable');
      expect(parseSelector(selectorText(parsed.selector))).toEqual(parsed);
    }
  });
});

describe('parseOrdered', () => {
  it('reads pods=ns/a,ns/b;persistentvolumes=pv1', () => {
    expect(parseOrdered('pods=ns/a,ns/b; persistentvolumes=pv1')).toEqual({
      value: { pods: 'ns/a,ns/b', persistentvolumes: 'pv1' },
    });
  });
  it.each(['pods', 'pods=', '=a'])('refuses %s', (text) => {
    expect('error' in parseOrdered(text)).toBe(true);
  });
});

describe('validate', () => {
  it('accepts an empty form for a user who may back up everything', () => {
    expect(validate(form(), open)).toEqual({});
  });

  it.each([
    ['a bad name', { name: 'Bad Name' }, 'name'],
    ['a namespace glob', { namespaces: 'dev*' }, 'namespaces'],
    ['an upper-case namespace', { namespaces: 'Dev' }, 'namespaces'],
    ['a bad excluded namespace', { excludeNamespaces: 'a/b' }, 'namespaces'],
    ['a bad duration', { ttl: 'a month' }, 'ttl'],
    ['a zero duration', { ttl: '0h' }, 'ttl'],
    ['a bad timeout', { itemOperationTimeout: '5' }, 'itemOperationTimeout'],
    ['a bad selector', { selector: 'a b' }, 'selector'],
    ['a bad or-selector', { orSelectors: 'app=web\nb c' }, 'orSelectors'],
    ['a bad ordered list', { orderedResources: 'pods' }, 'orderedResources'],
    ['too many uploads', { parallelFilesUpload: '100' }, 'parallelFilesUpload'],
    ['a fractional upload count', { parallelFilesUpload: '2.5' }, 'parallelFilesUpload'],
    ['a bad storage location', { storageLocation: 'Bad' }, 'storageLocation'],
    ['advanced that is not JSON', { advanced: '{' }, 'advanced'],
    ['advanced that is not an object', { advanced: '[1]' }, 'advanced'],
  ])('flags %s', (_name, over, field) => {
    expect(
      validate(form(over as Partial<BackupForm>), open)[field as keyof BackupForm],
    ).toBeTruthy();
  });

  it('accepts durations the server accepts', () => {
    for (const ttl of ['720h', '30m', '1h30m', '1.5s', '500ms']) {
      expect(validate(form({ ttl }), open).ttl).toBeUndefined();
    }
  });

  describe('for a user limited to some namespaces', () => {
    it('requires named namespaces and cluster-scoped resources switched off', () => {
      expect(validate(form({ clusterScoped: 'no' }), limited).namespaces).toBeTruthy();
      expect(
        validate(form({ clusterScoped: 'no', namespaces: '*' }), limited).namespaces,
      ).toBeTruthy();
      expect(
        validate(form({ clusterScoped: 'auto', namespaces: 'dev' }), limited).clusterScoped,
      ).toBeTruthy();
      expect(
        validate(form({ clusterScoped: 'yes', namespaces: 'dev' }), limited).clusterScoped,
      ).toBeTruthy();
      expect(
        validate(
          form({ clusterScoped: 'no', namespaces: 'dev', includeClusterScopedResources: 'nodes' }),
          limited,
        ).includeClusterScopedResources,
      ).toBeTruthy();
      expect(validate(form({ clusterScoped: 'no', namespaces: 'dev,qa' }), limited)).toEqual({});
    });

    it('starts with cluster-scoped resources off', () => {
      expect(emptyForm(true).clusterScoped).toBe('no');
      expect(emptyForm(false).clusterScoped).toBe('auto');
    });

    it('does not allow the advanced field', () => {
      expect(
        validate(form({ clusterScoped: 'no', namespaces: 'dev', advanced: '{}' }), limited)
          .advanced,
      ).toBeTruthy();
    });
  });
});

describe('toBody', () => {
  it('sends nothing for an empty form', () => {
    expect(toBody(form())).toEqual({});
  });

  it('sends exactly what was set, and an explicit "no" as false', () => {
    expect(
      toBody(
        form({
          name: ' nightly-1 ',
          namespaces: 'shop, cart',
          excludeResources: 'events',
          clusterScoped: 'no',
          selector: 'app=web,tier in (a,b)',
          orSelectors: 'a=b\nc=d',
          ttl: '72h',
          storageLocation: 'default',
          snapshotLocations: 'aws, gcp',
          snapshotVolumes: 'no',
          defaultVolumesToFsBackup: 'yes',
          snapshotMoveData: 'default',
          orderedResources: 'pods=shop/a,shop/b',
          parallelFilesUpload: '4',
          advanced: '{"hooks":{"resources":[]}}',
        }),
      ),
    ).toEqual({
      name: 'nightly-1',
      includedNamespaces: ['shop', 'cart'],
      excludedResources: ['events'],
      includeClusterResources: false,
      labelSelector: {
        matchLabels: { app: 'web' },
        matchExpressions: [{ key: 'tier', operator: 'In', values: ['a', 'b'] }],
      },
      orLabelSelectors: [{ matchLabels: { a: 'b' } }, { matchLabels: { c: 'd' } }],
      ttl: '72h',
      storageLocation: 'default',
      volumeSnapshotLocations: ['aws', 'gcp'],
      snapshotVolumes: false,
      defaultVolumesToFsBackup: true,
      orderedResources: { pods: 'shop/a,shop/b' },
      parallelFilesUpload: 4,
      advancedSpec: { hooks: { resources: [] } },
    });
  });

  it('leaves Velero’s default alone when the choice is "auto"', () => {
    expect('includeClusterResources' in toBody(form({ clusterScoped: 'auto' }))).toBe(false);
    expect(toBody(form({ clusterScoped: 'yes' })).includeClusterResources).toBe(true);
  });
});

describe('toCli', () => {
  it('is a bare command with a placeholder name for an empty form', () => {
    expect(toCli(form()).command).toBe('velero backup create <name>');
  });

  it('writes every flag the form can set', () => {
    const { command, notes } = toCli(
      form({
        name: 'nightly-1',
        namespaces: 'shop,cart',
        excludeNamespaces: 'tmp',
        includeResources: 'pods',
        excludeResources: 'events',
        clusterScoped: 'no',
        includeClusterScopedResources: 'persistentvolumes',
        excludeClusterScopedResources: 'nodes',
        includeNamespaceScopedResources: 'deployments',
        excludeNamespaceScopedResources: 'secrets',
        selector: 'app=web,tier in (a,b)',
        orSelectors: 'a=b\nc=d',
        ttl: '72h',
        storageLocation: 'default',
        snapshotLocations: 'aws',
        snapshotVolumes: 'no',
        defaultVolumesToFsBackup: 'yes',
        snapshotMoveData: 'yes',
        dataMover: 'velero',
        itemOperationTimeout: '4h',
        csiSnapshotTimeout: '10m',
        resourcePolicy: 'policy',
        orderedResources: 'pods=shop/a,shop/b',
        parallelFilesUpload: '4',
      }),
    );
    expect(command).toBe(
      "velero backup create nightly-1 --include-namespaces shop,cart --exclude-namespaces tmp --include-resources pods --exclude-resources events --include-cluster-resources=false --include-cluster-scoped-resources persistentvolumes --exclude-cluster-scoped-resources nodes --include-namespace-scoped-resources deployments --exclude-namespace-scoped-resources secrets --selector 'app=web,tier in (a,b)' --or-selector 'a=b or c=d' --ttl 72h --storage-location default --volume-snapshot-locations aws --snapshot-volumes=false --default-volumes-to-fs-backup=true --snapshot-move-data=true --data-mover velero --item-operation-timeout 4h --csi-snapshot-timeout 10m --resource-policies-configmap policy --ordered-resources pods=shop/a,shop/b --parallel-files-upload 4",
    );
    expect(notes).toEqual([]);
  });

  it('says what has no flag, and does not invent one', () => {
    const { command, notes } = toCli(form({ advanced: '{"a":1}' }));
    expect(command).toBe('velero backup create <name>');
    expect(notes).toHaveLength(1);
  });

  it('quotes anything a shell would read as syntax', () => {
    expect(shellQuote('plain-1.2')).toBe('plain-1.2');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shellQuote('a;b')).toBe("'a;b'");
    expect(toCli(form({ name: 'x', selector: 'app=web' })).command).toContain('--selector app=web');
  });

  it('describes the same backup as the API body (every set field appears in both)', () => {
    const f = form({
      name: 'x',
      namespaces: 'a,b',
      ttl: '1h',
      snapshotVolumes: 'no',
      storageLocation: 'loc',
      clusterScoped: 'no',
    });
    const body = toBody(f);
    const cli = toCli(f).command;
    expect(Object.keys(body).sort()).toEqual([
      'includeClusterResources',
      'includedNamespaces',
      'name',
      'snapshotVolumes',
      'storageLocation',
      'ttl',
    ]);
    for (const piece of [
      '--include-namespaces a,b',
      '--ttl 1h',
      '--snapshot-volumes=false',
      '--storage-location loc',
      '--include-cluster-resources=false',
    ]) {
      expect(cli).toContain(piece);
    }
  });
});
