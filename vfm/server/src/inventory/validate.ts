import type { ResourceItem } from '../gateway/pb/vfm/agent/v1/inventory';
import { clean } from '../streams/hello';
import { kindInfo } from './kinds';

/**
 * Validation of what an agent reports (PLAN.md §12: "treat the agent as
 * semi-trusted: a compromised cluster must not be able to corrupt another
 * cluster's data or inject script into the UI").
 *
 * Two things matter most. The **identity** an item claims (kind, namespace, name)
 * must agree with the object it carries, so an agent cannot label one object as
 * another. And **nothing is stored as sent**: strings are bounded and stripped of
 * control characters, maps are capped, timestamps are parsed or dropped.
 */

export const MAX_OBJECT_BYTES = 256 * 1024;

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const OBJECT_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const UID = /^[A-Za-z0-9-]{1,64}$/;

export interface ValidResource {
  kind: string;
  namespace: string;
  name: string;
  uid: string;
  resourceVersion: string;
  creationTimestamp: Date | null;
  phase: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
  labels: Record<string, string>;
  createdByVfm: boolean;
}

export interface ValidTombstone {
  kind: string;
  namespace: string;
  name: string;
  uid: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function identity(item: ResourceItem): Result<ValidTombstone & { objectKind: string }> {
  const info = kindInfo(item.kind);
  if (info === undefined) {
    return fail('unsupported kind');
  }
  if (info.clusterScoped === true) {
    // A node or a namespace belongs to no namespace; an agent that says otherwise is wrong.
    if (item.namespace !== '') {
      return fail('invalid namespace');
    }
  } else if (!DNS_LABEL.test(item.namespace) || item.namespace.length > 63) {
    return fail('invalid namespace');
  }
  if (!OBJECT_NAME.test(item.name) || item.name.length > 253) {
    return fail('invalid name');
  }
  if (!UID.test(item.uid)) {
    return fail('invalid uid');
  }
  return {
    ok: true,
    value: {
      kind: info.name,
      namespace: item.namespace,
      name: item.name,
      uid: item.uid,
      objectKind: info.objectKind,
    },
  };
}

/** A deleted object needs only its identity. */
export function validateTombstone(item: ResourceItem): Result<ValidTombstone> {
  const id = identity(item);
  if (!id.ok) {
    return id;
  }
  const { kind, namespace, name, uid } = id.value;
  return { ok: true, value: { kind, namespace, name, uid } };
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 40) {
    return null;
  }
  const parsed = new Date(value);
  // Plausible only: a hostile 0001 or 9999 date would wreck sorting and charts.
  const year = parsed.getUTCFullYear();
  return Number.isNaN(parsed.getTime()) || year < 2000 || year > 2100 ? null : parsed;
}

function path(object: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = object;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function labelsOf(metadata: Record<string, unknown>): Record<string, string> {
  const raw = metadata.labels;
  const out: Record<string, string> = {};
  if (!isRecord(raw)) {
    return out;
  }
  for (const [key, value] of Object.entries(raw).slice(0, 64)) {
    if (typeof value === 'string' && key.length <= 253) {
      out[clean(key, 253)] = clean(value, 255);
    }
  }
  return out;
}

/** Validates a full item and extracts the columns lists filter and sort on. */
export function validateItem(item: ResourceItem): Result<ValidResource> {
  const id = identity(item);
  if (!id.ok) {
    return id;
  }
  if (item.objectJson.length === 0) {
    return fail('no object');
  }
  if (item.objectJson.length > MAX_OBJECT_BYTES) {
    return fail('object too large');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(item.objectJson).toString('utf8'));
  } catch {
    return fail('object is not JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.metadata)) {
    return fail('object has no metadata');
  }

  // The claimed identity must be the object's own. This is what stops an agent
  // from filing one object under another's name.
  if (parsed.kind !== id.value.objectKind) {
    return fail('object kind does not match the item kind');
  }
  if (parsed.metadata.name !== item.name || (parsed.metadata.namespace ?? '') !== item.namespace) {
    return fail('object identity does not match the item');
  }
  if (typeof parsed.metadata.uid === 'string' && parsed.metadata.uid !== item.uid) {
    return fail('object uid does not match the item');
  }

  const spec = isRecord(parsed.spec) ? parsed.spec : {};
  const status = isRecord(parsed.status) ? parsed.status : {};
  const phase = path(parsed, 'status', 'phase');
  const annotations = path(parsed, 'metadata', 'annotations');

  return {
    ok: true,
    value: {
      kind: id.value.kind,
      namespace: id.value.namespace,
      name: id.value.name,
      uid: id.value.uid,
      resourceVersion: clean(item.resourceVersion, 64),
      creationTimestamp: timestamp(parsed.metadata.creationTimestamp),
      phase: typeof phase === 'string' && phase !== '' ? clean(phase, 64) : null,
      startedAt: timestamp(status.startTimestamp),
      completedAt: timestamp(status.completionTimestamp),
      expiresAt: timestamp(status.expiration),
      spec,
      status,
      labels: labelsOf(parsed.metadata),
      createdByVfm: isRecord(annotations) && annotations['vfm.io/managed'] === 'true',
    },
  };
}
