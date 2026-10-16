import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ResourceKind, type ResourceItem } from '../gateway/pb/vfm/agent/v1/inventory';
import { MAX_OBJECT_BYTES, validateItem, validateTombstone } from './validate';

const enc = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));

function backup(
  overrides: Partial<ResourceItem> = {},
  object: Record<string, unknown> = {},
): ResourceItem {
  return {
    kind: ResourceKind.RESOURCE_KIND_BACKUP,
    namespace: 'velero',
    name: 'nightly-20261016',
    uid: 'a1b2-c3d4',
    resourceVersion: '42',
    creationTimestamp: undefined,
    objectJson: enc({
      apiVersion: 'velero.io/v1',
      kind: 'Backup',
      metadata: {
        name: 'nightly-20261016',
        namespace: 'velero',
        uid: 'a1b2-c3d4',
        creationTimestamp: '2026-10-16T01:00:00Z',
        labels: { 'velero.io/schedule-name': 'nightly' },
        annotations: { 'vfm.io/managed': 'true' },
      },
      spec: { storageLocation: 'default', includedNamespaces: ['shop'] },
      status: {
        phase: 'Completed',
        startTimestamp: '2026-10-16T01:00:05Z',
        completionTimestamp: '2026-10-16T01:03:00Z',
        expiration: '2026-11-15T01:00:00Z',
      },
      ...object,
    }),
    ...overrides,
  };
}

describe('validateItem', () => {
  it('accepts a backup and extracts the columns lists filter on', () => {
    const r = validateItem(backup());
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.value).toMatchObject({
      kind: 'BACKUP',
      namespace: 'velero',
      name: 'nightly-20261016',
      phase: 'Completed',
      createdByVfm: true,
      labels: { 'velero.io/schedule-name': 'nightly' },
    });
    expect(r.value.startedAt?.toISOString()).toBe('2026-10-16T01:00:05.000Z');
    expect(r.value.completedAt?.toISOString()).toBe('2026-10-16T01:03:00.000Z');
    expect(r.value.expiresAt?.toISOString()).toBe('2026-11-15T01:00:00.000Z');
    expect(r.value.spec).toMatchObject({ storageLocation: 'default' });
  });

  it('treats an object created with the CLI as not created by VFM', () => {
    const r = validateItem(
      backup({}, { metadata: { name: 'nightly-20261016', namespace: 'velero', uid: 'a1b2-c3d4' } }),
    );
    expect(r.ok && r.value.createdByVfm).toBe(false);
  });

  it.each([
    ['an unsupported kind', backup({ kind: ResourceKind.RESOURCE_KIND_POD })],
    ['an unspecified kind', backup({ kind: ResourceKind.RESOURCE_KIND_UNSPECIFIED })],
    ['a namespace that is not a DNS label', backup({ namespace: 'Velero_NS' })],
    ['an empty namespace', backup({ namespace: '' })],
    ['a name with a slash', backup({ name: '../etc/passwd' })],
    ['an overlong name', backup({ name: 'a'.repeat(254) })],
    ['a uid with odd characters', backup({ uid: '<script>' })],
    ['an empty uid', backup({ uid: '' })],
    ['no object', backup({ objectJson: new Uint8Array() })],
    ['an object that is not JSON', backup({ objectJson: Buffer.from('{nope') })],
    ['a JSON array', backup({ objectJson: enc([1, 2, 3]) })],
    ['an object without metadata', backup({ objectJson: enc({ kind: 'Backup' }) })],
    ['an oversized object', backup({ objectJson: Buffer.alloc(MAX_OBJECT_BYTES + 1, 0x20) })],
  ])('refuses %s', (_name, item) => {
    expect(validateItem(item).ok).toBe(false);
  });

  it('refuses an item whose object claims to be a different thing', () => {
    // Filed as a Backup, but the object says it is a Restore.
    expect(validateItem(backup({}, { kind: 'Restore' })).ok).toBe(false);
    // Filed as "a", but the object is named "b".
    expect(
      validateItem(
        backup({ name: 'a' }, { metadata: { name: 'b', namespace: 'velero', uid: 'a1b2-c3d4' } }),
      ).ok,
    ).toBe(false);
    // Filed in one namespace, object lives in another.
    expect(
      validateItem(
        backup(
          {},
          { metadata: { name: 'nightly-20261016', namespace: 'other', uid: 'a1b2-c3d4' } },
        ),
      ).ok,
    ).toBe(false);
    // A different uid.
    expect(
      validateItem(
        backup({}, { metadata: { name: 'nightly-20261016', namespace: 'velero', uid: 'forged' } }),
      ).ok,
    ).toBe(false);
  });

  it('bounds and cleans what it keeps', () => {
    const r = validateItem(
      backup(
        { resourceVersion: '9'.repeat(500) },
        {
          metadata: {
            name: 'nightly-20261016',
            namespace: 'velero',
            uid: 'a1b2-c3d4',
            labels: { ok: 'fine', ['x'.repeat(300)]: 'dropped', ctl: 'a\u0007b\u001b[31m', n: 5 },
          },
          status: { phase: 'In\u0000Progress' + 'x'.repeat(200) },
        },
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.value.resourceVersion.length).toBeLessThanOrEqual(64);
    expect(r.value.phase?.length).toBeLessThanOrEqual(64);
    expect(
      Array.from(
        { length: r.value.phase?.length ?? 0 },
        (_, i) => r.value.phase?.charCodeAt(i) ?? 0,
      ).every((c) => c >= 32),
    ).toBe(true);
    expect(Object.keys(r.value.labels)).toEqual(['ok', 'ctl']);
    expect(r.value.labels.ctl).toBe('ab[31m');
  });

  it('drops timestamps that cannot be right instead of storing them', () => {
    const r = validateItem(
      backup(
        {},
        {
          status: {
            startTimestamp: 'not a date',
            completionTimestamp: '0001-01-01T00:00:00Z',
            expiration: '9999-12-31T00:00:00Z',
          },
        },
      ),
    );
    expect(r.ok && [r.value.startedAt, r.value.completedAt, r.value.expiresAt]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('caps the number of labels', () => {
    const labels = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i.toString()}`, 'v']),
    );
    const r = validateItem(
      backup(
        {},
        { metadata: { name: 'nightly-20261016', namespace: 'velero', uid: 'a1b2-c3d4', labels } },
      ),
    );
    expect(r.ok && Object.keys(r.value.labels).length).toBe(64);
  });
});

describe('validateTombstone', () => {
  it('needs only identity', () => {
    const r = validateTombstone(backup({ objectJson: new Uint8Array() }));
    expect(r).toEqual({
      ok: true,
      value: { kind: 'BACKUP', namespace: 'velero', name: 'nightly-20261016', uid: 'a1b2-c3d4' },
    });
  });

  it('still refuses a malformed identity', () => {
    expect(validateTombstone(backup({ name: 'bad name' })).ok).toBe(false);
    expect(validateTombstone(backup({ kind: ResourceKind.RESOURCE_KIND_NODE })).ok).toBe(false);
  });
});

describe('the live-view kinds', () => {
  const live = (
    kind: ResourceKind,
    objectKind: string,
    namespace: string,
    over: Record<string, unknown> = {},
  ): ResourceItem => ({
    kind,
    namespace,
    name: 'thing',
    uid: 'uid-1',
    resourceVersion: '1',
    creationTimestamp: undefined,
    objectJson: enc({
      apiVersion: 'v1',
      kind: objectKind,
      metadata: { name: 'thing', ...(namespace === '' ? {} : { namespace }), uid: 'uid-1' },
      status: { phase: 'Running' },
      ...over,
    }),
  });

  it('takes a node and a namespace with no namespace, and a pod with one', () => {
    expect(validateItem(live(ResourceKind.RESOURCE_KIND_NODE, 'Node', ''))).toMatchObject({
      ok: true,
    });
    expect(validateItem(live(ResourceKind.RESOURCE_KIND_NAMESPACE, 'Namespace', ''))).toMatchObject(
      { ok: true },
    );
    expect(validateItem(live(ResourceKind.RESOURCE_KIND_POD, 'Pod', 'shop'))).toMatchObject({
      ok: true,
      value: { kind: 'POD', namespace: 'shop', phase: 'Running' },
    });
  });

  it('refuses a node that names a namespace and a pod that names none', () => {
    expect(validateItem(live(ResourceKind.RESOURCE_KIND_NODE, 'Node', 'shop'))).toMatchObject({
      ok: false,
    });
    expect(validateItem(live(ResourceKind.RESOURCE_KIND_POD, 'Pod', ''))).toMatchObject({
      ok: false,
    });
  });

  it('refuses an object filed under another kind', () => {
    expect(validateItem(live(ResourceKind.RESOURCE_KIND_POD, 'Node', 'shop'))).toMatchObject({
      ok: false,
    });
  });

  it('still has no kind for a Secret', () => {
    expect(
      validateItem(live(ResourceKind.RESOURCE_KIND_UNSPECIFIED, 'Secret', 'shop')),
    ).toMatchObject({
      ok: false,
      reason: 'unsupported kind',
    });
  });
});

describe('what the agent really sends for the live view', () => {
  // test/fixtures/core-projections.json was produced by the agent's own projections
  // (agent/internal/inventory/core.go) so the two sides cannot drift apart unnoticed.
  it('is accepted, kind by kind', () => {
    const fixtures = JSON.parse(
      readFileSync(join(__dirname, '../../test/fixtures/core-projections.json'), 'utf8'),
    ) as {
      kind: number;
      namespace: string;
      name: string;
      uid: string;
      resourceVersion: string;
      object: unknown;
    }[];
    expect(fixtures).toHaveLength(5);
    for (const f of fixtures) {
      const result = validateItem({
        kind: ResourceKind[ResourceKind[f.kind] as keyof typeof ResourceKind],
        namespace: f.namespace,
        name: f.name,
        uid: f.uid,
        resourceVersion: f.resourceVersion,
        creationTimestamp: undefined,
        objectJson: enc(f.object),
      });
      expect(result, f.name).toMatchObject({ ok: true });
    }
  });
});
