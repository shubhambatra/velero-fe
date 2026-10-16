import { describe, expect, it } from 'vitest';

import {
  emptyLocationForm,
  fromLocationSpec,
  toLocationBody,
  toLocationCli,
  validateLocation,
  type LocationForm,
} from './location-form';

const backup = (over: Partial<LocationForm> = {}): LocationForm => ({
  ...emptyLocationForm('backup'),
  name: 'primary',
  bucket: 'backups',
  settings: [{ key: 'region', value: 'eu-west-1' }],
  credentialMode: 'none',
  ...over,
});

describe('validating a location', () => {
  it('accepts a complete form', () => {
    expect(validateLocation(backup(), false)).toEqual({});
  });

  it.each([
    ['no name', { name: '' }, 'name'],
    ['an upper-case name', { name: 'Primary' }, 'name'],
    ['no bucket', { bucket: '' }, 'bucket'],
    ['a bucket with a slash', { bucket: 'a/b' }, 'bucket'],
    ['an unreadable duration', { backupSyncPeriod: 'often' }, 'backupSyncPeriod'],
    ['a CA that is not a certificate', { caCert: 'x' }, 'caCert'],
    ['a setting that names a secret', { settings: [{ key: 'secretKey', value: 'x' }] }, 'settings'],
    [
      'a setting twice',
      {
        settings: [
          { key: 'a', value: '1' },
          { key: 'a', value: '2' },
        ],
      },
      'settings',
    ],
    ['a Secret without a name', { credentialMode: 'existing', secretName: '' }, 'secretName'],
    [
      'an empty pasted credential',
      { credentialMode: 'new', credentialText: ' ' },
      'credentialText',
    ],
  ] as const)('refuses %s', (_name, over, field) => {
    expect(validateLocation(backup(over as Partial<LocationForm>), false)[field]).toBeDefined();
  });

  it('does not ask for a name when editing, nor a bucket for a snapshot location', () => {
    expect(validateLocation(backup({ name: '' }), true).name).toBeUndefined();
    const vsl = {
      ...emptyLocationForm('snapshot'),
      name: 'snaps',
      credentialMode: 'none' as const,
    };
    expect(validateLocation(vsl, false)).toEqual({});
  });
});

describe('the request body', () => {
  it('holds only what was filled in', () => {
    expect(toLocationBody(backup(), true)).toEqual({
      name: 'primary',
      provider: 'aws',
      config: { region: 'eu-west-1' },
      bucket: 'backups',
    });
  });

  it('carries every optional field and a pasted credential', () => {
    const body = toLocationBody(
      backup({
        prefix: 'prod',
        accessMode: 'ReadOnly',
        isDefault: true,
        backupSyncPeriod: '2m',
        validationFrequency: '1h',
        caCert: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
        credentialMode: 'new',
        credentialText: 'key-text',
      }),
      true,
    );
    expect(body).toMatchObject({
      prefix: 'prod',
      accessMode: 'ReadOnly',
      default: true,
      backupSyncPeriod: '2m',
      validationFrequency: '1h',
      credential: { content: 'key-text' },
    });
  });

  it('references a Secret that exists, or leaves the credential out when it is kept', () => {
    expect(
      toLocationBody(
        backup({ credentialMode: 'existing', secretName: 'cloud-credentials', secretKey: 'cloud' }),
        false,
      ).credential,
    ).toEqual({ secretName: 'cloud-credentials', key: 'cloud' });
    const kept = toLocationBody(backup({ credentialMode: 'keep' }), false);
    expect(kept).not.toHaveProperty('credential');
    expect(kept).not.toHaveProperty('name');
  });
});

describe('the equivalent command', () => {
  it('never contains the credential', () => {
    const cli = toLocationCli(
      backup({ credentialMode: 'new', credentialText: 'TOPSECRET' }),
      false,
    );
    expect(cli.command).not.toContain('TOPSECRET');
    expect(cli.command).toBe(
      'velero backup-location create primary --provider aws --bucket backups --config region=eu-west-1',
    );
    expect(cli.notes.join(' ')).toContain('--secret-file');
  });

  it('names an existing Secret and the default flag', () => {
    const cli = toLocationCli(
      backup({
        credentialMode: 'existing',
        secretName: 'creds',
        secretKey: 'cloud',
        isDefault: true,
      }),
      false,
    );
    expect(cli.command).toContain('--credential creds=cloud');
    expect(cli.command).toContain('--default');
  });

  it('describes snapshot locations', () => {
    const f = { ...emptyLocationForm('snapshot'), name: 'snaps', settings: [] };
    expect(toLocationCli(f, false).command).toBe(
      'velero snapshot-location create snaps --provider aws',
    );
  });
});

describe('starting an edit from the stored spec', () => {
  it('reads the fields back, including the CA certificate and the Secret in use', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n';
    const f = fromLocationSpec('backup', 'primary', {
      provider: 'aws',
      config: { region: 'r' },
      credential: { name: 'cloud-credentials', key: 'cloud' },
      objectStorage: { bucket: 'b', prefix: 'p', caCert: btoa(pem) },
      default: true,
      accessMode: 'ReadOnly',
      backupSyncPeriod: '1m0s',
    });
    expect(f).toMatchObject({
      name: 'primary',
      bucket: 'b',
      prefix: 'p',
      isDefault: true,
      accessMode: 'ReadOnly',
      backupSyncPeriod: '1m0s',
      caCert: pem,
      credentialMode: 'keep',
      current: { name: 'cloud-credentials', key: 'cloud' },
      settings: [{ key: 'region', value: 'r' }],
    });
    expect(validateLocation(f, true)).toEqual({});
  });

  it('copes with a spec that has little in it', () => {
    expect(fromLocationSpec('snapshot', 'v', null)).toMatchObject({
      credentialMode: 'none',
      current: null,
    });
  });
});
