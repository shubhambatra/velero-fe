import { z } from 'zod';

import { duration, durationSeconds, OBJECT_NAME } from '../backups/backup-request';
import { TransientUnavailableError, type Transient } from '../commands/transient';
import type { Command } from '../gateway/pb/vfm/agent/v1/command';
import { BackupStorageLocationAccessMode } from '../gateway/pb/vfm/agent/v1/velero';

/**
 * The API bodies of the storage-location endpoints and how they become the protobuf the
 * agent receives (PLAN.md §5.2, §6, §12.1).
 *
 * ## The credential
 *
 * A location can be given a credential: the text of a cloud key file. It crosses the
 * control plane once, inside the request, and goes to the agent in the command; the agent
 * writes it to a Secret and Velero reads it from there. It is never stored: the command
 * row keeps a payload without it (`rotatesSecret: true` says one was sent), and the text
 * is held in memory only until the command finishes ({@link Transient}).
 *
 * A location can instead point at a Secret that is already in the cluster, by name; then
 * no secret material is involved at all.
 */

export const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_CA_BYTES = 64 * 1024;
const MAX_SYNC_SECONDS = 7 * 24 * 3600;

const SECRET_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const SECRET_KEY = /^[-._a-zA-Z0-9]+$/;
const PROVIDER = /^[a-z0-9][a-z0-9./_-]*$/;
const CONFIG_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const locationName = z.string().max(63).regex(OBJECT_NAME);

/**
 * With `content`: a credential to store in a Secret (`secretName` defaults to
 * `vfm-bsl-<name>`, `key` to `cloud`). Without it: a reference to a Secret that exists
 * (`secretName` is then required).
 */
const credential = z
  .object({
    secretName: z.string().max(253).regex(SECRET_NAME).optional(),
    key: z.string().max(253).regex(SECRET_KEY).optional(),
    content: z.string().min(1).max(MAX_CREDENTIAL_BYTES).optional(),
  })
  .strict();

/** Settings are stored and shown as they are, so a key that names a secret is refused: use the credential field. */
const SECRET_LOOKING = /password|passwd|secret|token|accesskey|privatekey|credential/i;

const config = z
  .record(z.string().max(63).regex(CONFIG_KEY), z.string().max(1024))
  .refine((c) => Object.keys(c).length <= 50, 'at most 50 settings')
  .refine(
    (c) => !Object.keys(c).some((key) => SECRET_LOOKING.test(key)),
    'settings are stored and shown as they are; give secrets in the credential field',
  );

const provider = z.string().min(1).max(63).regex(PROVIDER);

const common = { provider, config: config.optional(), credential: credential.optional() };

const backupFields = {
  ...common,
  bucket: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\s/]+$/, 'a bucket name: no spaces or slashes'),
  prefix: z.string().max(512).optional(),
  /** PEM text of a CA certificate to trust when talking to the storage endpoint. */
  caCert: z
    .string()
    .max(MAX_CA_BYTES)
    .refine((text) => text.includes('-----BEGIN CERTIFICATE-----'), 'a PEM certificate')
    .optional(),
  accessMode: z.enum(['ReadOnly', 'ReadWrite']).optional(),
  backupSyncPeriod: duration.optional(),
  validationFrequency: duration.optional(),
  default: z.boolean().optional(),
};

export const createBackupLocationBody = z.object({ name: locationName, ...backupFields }).strict();
export const updateBackupLocationBody = z.object(backupFields).strict();
export const createSnapshotLocationBody = z.object({ name: locationName, ...common }).strict();
export const updateSnapshotLocationBody = z.object(common).strict();

export type UpdateBackupLocationBody = z.infer<typeof updateBackupLocationBody>;
export type UpdateSnapshotLocationBody = z.infer<typeof updateSnapshotLocationBody>;
type Fields = Pick<UpdateBackupLocationBody, 'provider' | 'config' | 'credential'>;

/** A message when the body is out of range or inconsistent. */
export function checkLocation(
  body: Fields &
    Partial<Pick<UpdateBackupLocationBody, 'backupSyncPeriod' | 'validationFrequency'>>,
): string | undefined {
  const c = body.credential;
  if (c !== undefined && c.content === undefined && c.secretName === undefined) {
    return 'credential: name the Secret to use, or give the credential text';
  }
  if (c !== undefined && c.content === undefined && c.key === undefined) {
    return 'credential: name the key inside the Secret';
  }
  if (c?.content !== undefined && Buffer.byteLength(c.content) > MAX_CREDENTIAL_BYTES) {
    return 'credential: the text is too large';
  }
  for (const key of ['backupSyncPeriod', 'validationFrequency'] as const) {
    const text = body[key];
    if (text !== undefined) {
      const d = durationSeconds(text);
      if (d === undefined || d.seconds > MAX_SYNC_SECONDS) {
        return `${key} must be between a second and 7 days`;
      }
    }
  }
  return undefined;
}

/** What is stored on the command, and what the builders below read. */
export type LocationPayload = {
  name: string;
  spec: Record<string, unknown>;
  /** The Secret the location points at: a name and a key, never contents. */
  secretRef?: { name: string; key: string };
  /** Set when credential text accompanies the command (and is held only in memory). */
  rotatesSecret?: boolean;
};

/**
 * Splits a validated body into the payload to store and the secret material to hold in
 * memory. `existingRef` is the reference the location has now (an update that does not
 * mention the credential keeps it).
 */
export function splitCredential(
  prefix: 'vfm-bsl' | 'vfm-vsl',
  name: string,
  input: Fields,
  existingRef?: { name: string; key: string },
): { secretRef?: { name: string; key: string }; rotatesSecret?: true; transient?: Transient } {
  const c = input.credential;
  if (c === undefined) {
    return existingRef === undefined ? {} : { secretRef: existingRef };
  }
  if (c.content === undefined) {
    return { secretRef: { name: c.secretName ?? '', key: c.key ?? '' } };
  }
  return {
    secretRef: { name: c.secretName ?? `${prefix}-${name}`.slice(0, 253), key: c.key ?? 'cloud' },
    rotatesSecret: true,
    transient: { credential: Buffer.from(c.content, 'utf8') },
  };
}

// ---------------------------------------------------------------------------
// What the agent receives.

const secretKeyRef = (ref: { name: string; key: string } | undefined) =>
  ref === undefined ? undefined : { name: ref.name, key: ref.key };

function credentialMessage(payload: LocationPayload, transient: Transient | undefined) {
  if (payload.rotatesSecret !== true || payload.secretRef === undefined) {
    return undefined;
  }
  if (transient?.credential === undefined) {
    throw new TransientUnavailableError();
  }
  return {
    ref: secretKeyRef(payload.secretRef),
    content: new Uint8Array(transient.credential),
  };
}

const accessModes = {
  ReadOnly: BackupStorageLocationAccessMode.BSL_ACCESS_MODE_READ_ONLY,
  ReadWrite: BackupStorageLocationAccessMode.BSL_ACCESS_MODE_READ_WRITE,
} as const;

export function buildUpsertBsl(
  raw: Record<string, unknown>,
  transient?: Transient,
): Partial<Command> {
  const payload = raw as unknown as LocationPayload;
  const s = payload.spec as Partial<UpdateBackupLocationBody>;
  return {
    upsertBsl: {
      name: payload.name,
      spec: {
        provider: s.provider ?? '',
        config: s.config ?? {},
        credential: secretKeyRef(payload.secretRef),
        objectStorage: {
          bucket: s.bucket ?? '',
          prefix: s.prefix ?? '',
          caCert: s.caCert === undefined ? new Uint8Array() : Buffer.from(s.caCert, 'utf8'),
          caCertRef: undefined,
        },
        default: s.default === true,
        accessMode:
          s.accessMode === undefined
            ? BackupStorageLocationAccessMode.BSL_ACCESS_MODE_UNSPECIFIED
            : accessModes[s.accessMode],
        backupSyncPeriod:
          s.backupSyncPeriod === undefined ? undefined : durationSeconds(s.backupSyncPeriod),
        validationFrequency:
          s.validationFrequency === undefined ? undefined : durationSeconds(s.validationFrequency),
      },
      credential: credentialMessage(payload, transient),
    },
  };
}

export function buildUpsertVsl(
  raw: Record<string, unknown>,
  transient?: Transient,
): Partial<Command> {
  const payload = raw as unknown as LocationPayload;
  const s = payload.spec as Partial<UpdateSnapshotLocationBody>;
  return {
    upsertVsl: {
      name: payload.name,
      spec: {
        provider: s.provider ?? '',
        config: s.config ?? {},
        credential: secretKeyRef(payload.secretRef),
      },
      credential: credentialMessage(payload, transient),
    },
  };
}

export function buildSetDefaultBsl(payload: Record<string, unknown>): Partial<Command> {
  return { setDefaultBsl: { name: String(payload.name) } };
}

export const buildDeleteLocation =
  (arm: 'deleteBsl' | 'deleteVsl') =>
  (payload: Record<string, unknown>): Partial<Command> => ({
    [arm]: { name: String(payload.name) },
  });
