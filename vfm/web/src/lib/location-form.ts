/**
 * The form behind "add / change a storage location" (PLAN.md §6, §11.1): its state,
 * checks, the API body it becomes, and the equivalent `velero` command.
 *
 * Credential text lives only in the form's state until it is sent; nothing here
 * writes it to storage, to the URL or to the command preview.
 */

export type LocationKind = 'backup' | 'snapshot';

export type CredentialMode = 'keep' | 'existing' | 'new' | 'none';

export interface LocationForm {
  kind: LocationKind;
  name: string;
  provider: string;
  bucket: string;
  prefix: string;
  accessMode: '' | 'ReadOnly' | 'ReadWrite';
  isDefault: boolean;
  backupSyncPeriod: string;
  validationFrequency: string;
  settings: { key: string; value: string }[];
  caCert: string;
  credentialMode: CredentialMode;
  secretName: string;
  secretKey: string;
  credentialText: string;
  /** The Secret an existing location points at now (edit only). */
  current: { name: string; key: string } | null;
}

export const PROVIDERS: {
  value: string;
  label: string;
  settings: Record<LocationKind, string[]>;
}[] = [
  {
    value: 'aws',
    label: 'AWS S3 or S3-compatible (aws)',
    settings: { backup: ['region', 's3Url', 's3ForcePathStyle'], snapshot: ['region'] },
  },
  {
    value: 'gcp',
    label: 'Google Cloud Storage (gcp)',
    settings: { backup: ['kmsKeyName', 'serviceAccount'], snapshot: ['snapshotLocation'] },
  },
  {
    value: 'azure',
    label: 'Azure Blob Storage (azure)',
    settings: {
      backup: ['resourceGroup', 'storageAccount', 'subscriptionId'],
      snapshot: ['resourceGroup', 'subscriptionId'],
    },
  },
];

export function emptyLocationForm(kind: LocationKind): LocationForm {
  return {
    kind,
    name: '',
    provider: 'aws',
    bucket: '',
    prefix: '',
    accessMode: '',
    isDefault: false,
    backupSyncPeriod: '',
    validationFrequency: '',
    settings: [{ key: 'region', value: '' }],
    caCert: '',
    credentialMode: 'new',
    secretName: '',
    secretKey: 'cloud',
    credentialText: '',
    current: null,
  };
}

const NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const DURATION = /^(\d+(\.\d+)?(ms|s|m|h))+$/;
const SECRET_LOOKING = /password|passwd|secret|token|accesskey|privatekey|credential/i;
export const MAX_CREDENTIAL = 64 * 1024;

export type LocationErrors = Partial<Record<keyof LocationForm | 'settings', string>>;

export function validateLocation(f: LocationForm, editing: boolean): LocationErrors {
  const e: LocationErrors = {};
  if (!editing) {
    if (f.name === '') {
      e.name = 'Give the location a name.';
    } else if (f.name.length > 63 || !NAME.test(f.name)) {
      e.name =
        'Use lower-case letters, digits, "-" and ".", starting and ending with a letter or digit (up to 63).';
    }
  }
  if (f.provider.trim() === '' || !/^[a-z0-9][a-z0-9./_-]*$/.test(f.provider.trim())) {
    e.provider = 'Name the provider plugin, such as aws, gcp or azure.';
  }
  if (f.kind === 'backup') {
    if (f.bucket.trim() === '') {
      e.bucket = 'A bucket is required.';
    } else if (/[\s/]/.test(f.bucket)) {
      e.bucket = 'A bucket name has no spaces or slashes. Put a folder in the prefix.';
    }
    for (const key of ['backupSyncPeriod', 'validationFrequency'] as const) {
      if (f[key].trim() !== '' && !DURATION.test(f[key].trim())) {
        e[key] = 'Use a duration such as 1m, 30s or 1h.';
      }
    }
    if (f.caCert.trim() !== '' && !f.caCert.includes('-----BEGIN CERTIFICATE-----')) {
      e.caCert = 'Paste a PEM certificate, starting with -----BEGIN CERTIFICATE-----.';
    }
  }
  const keys = f.settings.map((s) => s.key.trim()).filter((k) => k !== '');
  if (keys.some((k) => SECRET_LOOKING.test(k))) {
    e.settings =
      'Settings are stored and shown as they are. Give secrets in the credential instead.';
  } else if (new Set(keys).size !== keys.length) {
    e.settings = 'A setting appears twice.';
  } else if (f.settings.some((s) => s.key.trim() === '' && s.value.trim() !== '')) {
    e.settings = 'Every value needs a name.';
  }
  if (f.credentialMode === 'existing') {
    if (f.secretName.trim() === '') {
      e.secretName = 'Name the Secret.';
    }
    if (f.secretKey.trim() === '') {
      e.secretKey = 'Name the key inside the Secret.';
    }
  }
  if (f.credentialMode === 'new') {
    if (f.credentialText.trim() === '') {
      e.credentialText = 'Paste the credential, or choose another option.';
    } else if (new Blob([f.credentialText]).size > MAX_CREDENTIAL) {
      e.credentialText = 'The credential is larger than 64 KiB.';
    }
  }
  return e;
}

export const hasLocationErrors = (e: LocationErrors): boolean => Object.keys(e).length > 0;

/** The credential part of a body, or `undefined` when the request leaves the Secret alone. */
function credentialOf(f: LocationForm): object | undefined {
  switch (f.credentialMode) {
    case 'new':
      return { content: f.credentialText };
    case 'existing':
      return { secretName: f.secretName.trim(), key: f.secretKey.trim() };
    default:
      return undefined;
  }
}

export function toLocationBody(f: LocationForm, creating: boolean): Record<string, unknown> {
  const config = Object.fromEntries(
    f.settings.filter((s) => s.key.trim() !== '').map((s) => [s.key.trim(), s.value]),
  );
  const credential = credentialOf(f);
  const body: Record<string, unknown> = {
    ...(creating ? { name: f.name } : {}),
    provider: f.provider.trim(),
    ...(Object.keys(config).length > 0 ? { config } : {}),
    ...(credential === undefined ? {} : { credential }),
  };
  if (f.kind === 'backup') {
    body.bucket = f.bucket.trim();
    if (f.prefix.trim() !== '') body.prefix = f.prefix.trim();
    if (f.caCert.trim() !== '') body.caCert = f.caCert.trim() + '\n';
    if (f.accessMode !== '') body.accessMode = f.accessMode;
    if (f.backupSyncPeriod.trim() !== '') body.backupSyncPeriod = f.backupSyncPeriod.trim();
    if (f.validationFrequency.trim() !== '') {
      body.validationFrequency = f.validationFrequency.trim();
    }
    if (f.isDefault) body.default = true;
  }
  return body;
}

const quote = (s: string): string =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** `velero …` for the form. The credential text is never part of it. */
export function toLocationCli(
  f: LocationForm,
  editing: boolean,
): { command: string; notes: string[] } {
  const notes: string[] = [];
  const noun = f.kind === 'backup' ? 'backup-location' : 'snapshot-location';
  const parts = [
    'velero',
    noun,
    editing ? 'set' : 'create',
    quote(f.name === '' ? 'NAME' : f.name),
  ];
  if (!editing) {
    parts.push('--provider', quote(f.provider));
    if (f.kind === 'backup') {
      parts.push('--bucket', quote(f.bucket === '' ? 'BUCKET' : f.bucket));
      if (f.prefix.trim() !== '') parts.push('--prefix', quote(f.prefix.trim()));
      if (f.accessMode !== '') parts.push('--access-mode', f.accessMode);
      if (f.backupSyncPeriod.trim() !== '') {
        parts.push('--backup-sync-period', f.backupSyncPeriod.trim());
      }
      if (f.validationFrequency.trim() !== '') {
        parts.push('--validation-frequency', f.validationFrequency.trim());
      }
    }
    const config = f.settings.filter((s) => s.key.trim() !== '');
    if (config.length > 0) {
      parts.push(
        '--config',
        config
          .map((s) => `${s.key.trim()}=${s.value}`)
          .map(quote)
          .join(','),
      );
    }
  } else {
    notes.push('`velero … set` changes only the credential, the CA certificate and the default.');
  }
  if (f.credentialMode === 'existing' && f.secretName.trim() !== '') {
    parts.push('--credential', quote(`${f.secretName.trim()}=${f.secretKey.trim()}`));
  }
  if (f.credentialMode === 'new') {
    notes.push(
      'The CLI reads a credential from a file (--secret-file ./credentials). Here you paste it; the agent writes it to a Secret and the control plane does not keep it.',
    );
  }
  if (f.kind === 'backup' && f.isDefault) parts.push('--default');
  return { command: parts.join(' '), notes };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function decodeBase64(value: string): string {
  try {
    return value === '' ? '' : atob(value);
  } catch {
    return '';
  }
}

/** Starts the edit form from the stored `spec`. */
export function fromLocationSpec(kind: LocationKind, name: string, specRaw: unknown): LocationForm {
  const spec = obj(specRaw);
  const store = obj(spec.objectStorage);
  const ref = obj(spec.credential);
  const caCert = decodeBase64(text(store.caCert));
  const mode = text(spec.accessMode);
  const base = emptyLocationForm(kind);
  const current = text(ref.name) === '' ? null : { name: text(ref.name), key: text(ref.key) };
  return {
    ...base,
    name,
    provider: text(spec.provider) || base.provider,
    bucket: text(store.bucket),
    prefix: text(store.prefix),
    accessMode: mode === 'ReadOnly' || mode === 'ReadWrite' ? mode : '',
    isDefault: spec.default === true,
    backupSyncPeriod: text(spec.backupSyncPeriod),
    validationFrequency: text(spec.validationFrequency),
    settings: Object.entries(obj(spec.config)).map(([key, value]) => ({ key, value: text(value) })),
    caCert,
    credentialMode: current === null ? 'none' : 'keep',
    current,
  };
}
