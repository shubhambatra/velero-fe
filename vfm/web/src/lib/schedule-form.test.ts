import { describe, expect, it } from 'vitest';

import { STEP_FIELDS } from './backup-form';
import {
  emptyScheduleForm,
  fromSpec,
  hasErrors,
  stepOfError,
  toScheduleBody,
  toScheduleCli,
  validateSchedule,
  type ScheduleForm,
} from './schedule-form';

const ctx = { limitedToNamespaces: false, mayUseAdvanced: true, editing: false };
const filled = (extra: Partial<ScheduleForm> = {}): ScheduleForm => ({
  ...emptyScheduleForm(false),
  name: 'nightly',
  ...extra,
});

describe('validateSchedule', () => {
  it('accepts a complete form', () => {
    expect(hasErrors(validateSchedule(filled(), ctx))).toBe(false);
  });

  it('needs a name when creating, but not when editing', () => {
    expect(validateSchedule(filled({ name: '' }), ctx).name).toMatch(/needs a name/);
    expect(validateSchedule(filled({ name: '' }), { ...ctx, editing: true }).name).toBeUndefined();
  });

  it('limits the name to what the backups it makes can carry', () => {
    expect(validateSchedule(filled({ name: 'a'.repeat(48) }), ctx).name).toBeUndefined();
    expect(validateSchedule(filled({ name: 'a'.repeat(49) }), ctx).name).toMatch(/48/);
    expect(validateSchedule(filled({ name: 'Not_Valid' }), ctx).name).toBeDefined();
  });

  it('reports an unreadable cron expression', () => {
    expect(validateSchedule(filled({ cron: 'every day' }), ctx).cron).toBeDefined();
    expect(validateSchedule(filled({ cron: '0 0 2 * * *' }), ctx).cron).toMatch(/five fields/);
    expect(validateSchedule(filled({ cron: '@daily' }), ctx).cron).toBeUndefined();
  });

  it('applies the backup rules to the template, scoped users included', () => {
    const scoped = { ...ctx, limitedToNamespaces: true };
    const e = validateSchedule(filled(), scoped);
    expect(e.template.namespaces).toBeDefined();
    expect(e.template.clusterScoped).toBeDefined();
    const ok = filled({
      template: { ...emptyScheduleForm(true).template, namespaces: 'dev' },
    });
    expect(hasErrors(validateSchedule(ok, scoped))).toBe(false);
  });

  it('points at the steps that have problems', () => {
    const e = validateSchedule(
      filled({ cron: 'x', template: { ...emptyScheduleForm(false).template, ttl: 'soon' } }),
      ctx,
    );
    expect(stepOfError(e, STEP_FIELDS)).toEqual([0, 3]);
  });
});

describe('toScheduleBody', () => {
  it('sends only what was set', () => {
    expect(toScheduleBody(filled(), true)).toEqual({
      name: 'nightly',
      schedule: '0 2 * * *',
      template: {},
    });
  });

  it('puts the backup settings in the template and the escape hatch at the top', () => {
    const form = filled({
      paused: true,
      skipImmediately: 'no',
      useOwnerReferences: 'yes',
      template: {
        ...emptyScheduleForm(false).template,
        namespaces: 'shop, cart',
        clusterScoped: 'no',
        ttl: '720h',
        advanced: '{"hooks":{"resources":[]}}',
      },
    });
    expect(toScheduleBody(form, true)).toEqual({
      name: 'nightly',
      schedule: '0 2 * * *',
      paused: true,
      skipImmediately: false,
      useOwnerReferencesInBackup: true,
      template: {
        includedNamespaces: ['shop', 'cart'],
        includeClusterResources: false,
        ttl: '720h',
      },
      advancedSpec: { hooks: { resources: [] } },
    });
  });

  it('leaves the name out when updating', () => {
    expect(toScheduleBody(filled(), false)).not.toHaveProperty('name');
  });

  it('carries what the form cannot show, unless the form says otherwise', () => {
    const form = filled({
      carried: { metadataLabels: { team: 'shop' }, volumeGroupSnapshotLabelKey: 'vgs' },
    });
    expect(toScheduleBody(form, false).template).toEqual({
      metadataLabels: { team: 'shop' },
      volumeGroupSnapshotLabelKey: 'vgs',
    });
  });
});

describe('toScheduleCli', () => {
  it('writes the equivalent velero schedule create', () => {
    const form = filled({
      cron: '0 2 * * 1-5',
      paused: true,
      skipImmediately: 'yes',
      template: {
        ...emptyScheduleForm(false).template,
        namespaces: 'shop',
        ttl: '720h',
        clusterScoped: 'no',
      },
    });
    expect(toScheduleCli(form).command).toBe(
      "velero schedule create nightly --schedule '0 2 * * 1-5' --paused --skip-immediately=true --include-namespaces shop --include-cluster-resources=false --ttl 720h",
    );
  });

  it('shows a placeholder until the name is typed', () => {
    expect(toScheduleCli(filled({ name: '' })).command).toBe(
      "velero schedule create <name> --schedule '0 2 * * *'",
    );
  });
});

describe('fromSpec', () => {
  const spec = {
    schedule: '30 1 * * 0',
    paused: true,
    skipImmediately: false,
    template: {
      includedNamespaces: ['shop', 'cart'],
      excludedResources: ['events'],
      includeClusterResources: false,
      labelSelector: { matchLabels: { app: 'web' } },
      orLabelSelectors: [
        { matchLabels: { a: 'b' } },
        { matchExpressions: [{ key: 'tier', operator: 'In', values: ['x', 'y'] }] },
      ],
      storageLocation: 'default',
      volumeSnapshotLocations: ['aws'],
      snapshotVolumes: false,
      ttl: '720h0m0s',
      resourcePolicy: { kind: 'ConfigMap', name: 'policy' },
      orderedResources: { pods: 'shop/a,shop/b' },
      uploaderConfig: { parallelFilesUpload: 4 },
      datamover: 'velero',
      metadata: { labels: { team: 'shop' } },
      volumeGroupSnapshotLabelKey: 'vgs',
      hooks: { resources: [{ name: 'freeze' }] },
    },
  };

  it('fills the form from a stored schedule', () => {
    const f = fromSpec(spec, 'nightly');
    expect(f).toMatchObject({
      name: 'nightly',
      cron: '30 1 * * 0',
      paused: true,
      skipImmediately: 'no',
      useOwnerReferences: 'default',
      hasHooks: true,
      carried: { metadataLabels: { team: 'shop' }, volumeGroupSnapshotLabelKey: 'vgs' },
    });
    expect(f.template).toMatchObject({
      namespaces: 'shop,cart',
      excludeResources: 'events',
      clusterScoped: 'no',
      selector: 'app=web',
      orSelectors: 'a=b\ntier in (x,y)',
      storageLocation: 'default',
      snapshotLocations: 'aws',
      snapshotVolumes: 'no',
      defaultVolumesToFsBackup: 'default',
      ttl: '720h0m0s',
      resourcePolicy: 'policy',
      orderedResources: 'pods=shop/a,shop/b',
      parallelFilesUpload: '4',
      dataMover: 'velero',
    });
  });

  it('produces a form that validates and sends the same spec back (a round trip)', () => {
    const f = fromSpec(spec, 'nightly');
    expect(hasErrors(validateSchedule(f, { ...ctx, editing: true }))).toBe(false);
    const body = toScheduleBody(f, false);
    expect(body).toMatchObject({
      schedule: '30 1 * * 0',
      paused: true,
      skipImmediately: false,
      template: {
        includedNamespaces: ['shop', 'cart'],
        excludedResources: ['events'],
        includeClusterResources: false,
        labelSelector: { matchLabels: { app: 'web' } },
        orLabelSelectors: [
          { matchLabels: { a: 'b' } },
          { matchExpressions: [{ key: 'tier', operator: 'In', values: ['x', 'y'] }] },
        ],
        storageLocation: 'default',
        volumeSnapshotLocations: ['aws'],
        snapshotVolumes: false,
        ttl: '720h0m0s',
        resourcePolicy: 'policy',
        orderedResources: { pods: 'shop/a,shop/b' },
        parallelFilesUpload: 4,
        dataMover: 'velero',
        metadataLabels: { team: 'shop' },
        volumeGroupSnapshotLabelKey: 'vgs',
      },
    });
    expect(body).not.toHaveProperty('advancedSpec');
  });

  it('copes with an empty or odd spec', () => {
    for (const odd of [undefined, null, 5, [], {}, { template: 'x' }]) {
      const f = fromSpec(odd, 'a');
      expect(f.template.namespaces).toBe('');
      expect(f.hasHooks).toBe(false);
    }
  });
});
