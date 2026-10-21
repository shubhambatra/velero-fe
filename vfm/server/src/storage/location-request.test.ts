import { describe, expect, it } from 'vitest';

import { TransientUnavailableError } from '../commands/transient';
import {
  buildDeleteLocation,
  buildSetDefaultBsl,
  buildUpsertBsl,
  buildUpsertVsl,
  checkLocation,
  createBackupLocationBody,
  createSnapshotLocationBody,
  splitCredential,
  updateBackupLocationBody,
} from './location-request';

const valid = { name: 'primary', provider: 'aws', bucket: 'backups' };

describe('backup location bodies', () => {
  it('accept the fields of a location and nothing else', () => {
    expect(createBackupLocationBody.safeParse(valid).success).toBe(true);
    expect(createBackupLocationBody.safeParse({ ...valid, nope: 1 }).success).toBe(false);
    expect(updateBackupLocationBody.safeParse({ provider: 'aws', bucket: 'b' }).success).toBe(true);
    // The name is in the URL on an update, not in the body.
    expect(updateBackupLocationBody.safeParse({ ...valid }).success).toBe(false);
  });

  it.each([
    ['a bucket with a slash', { bucket: 'a/b' }],
    ['a bucket with a space', { bucket: 'a b' }],
    ['an upper-case name', { name: 'Primary' }],
    ['a provider with a space', { provider: 'a b' }],
    ['a CA that is not a certificate', { caCert: 'x' }],
    [
      'more than 50 settings',
      {
        config: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i.toString()}`, 'v'])),
      },
    ],
    ['a setting named like a secret', { config: { accessKey: 'x' } }],
    ['a setting holding a password', { config: { dbPassword: 'x' } }],
    ['a setting holding a token', { config: { apiToken: 'x' } }],
    ['credential text over 64 KiB', { credential: { content: 'x'.repeat(65 * 1024) } }],
  ])('refuse %s', (_name, extra) => {
    expect(createBackupLocationBody.safeParse({ ...valid, ...extra }).success).toBe(false);
  });

  it('accept the settings real providers use, including ones that merely contain a sensitive word', () => {
    const config = {
      region: 'eu-west-1',
      s3Url: 'https://minio.local:9000',
      s3ForcePathStyle: 'true',
      signatureVersion: '4',
      profile: 'default',
      resourceGroup: 'rg',
      storageAccount: 'acct',
      kmsKeyId: 'alias/backups',
    };
    expect(createBackupLocationBody.safeParse({ ...valid, config }).success).toBe(true);
  });
});

describe('checkLocation', () => {
  it('wants a name for a Secret that is only referenced, and the key in it', () => {
    expect(checkLocation({ provider: 'aws', credential: {} })).toMatch(/name the Secret/);
    expect(checkLocation({ provider: 'aws', credential: { secretName: 'x' } })).toMatch(/key/);
    expect(
      checkLocation({ provider: 'aws', credential: { secretName: 'x', key: 'cloud' } }),
    ).toBeUndefined();
    expect(checkLocation({ provider: 'aws', credential: { content: 'abc' } })).toBeUndefined();
    expect(checkLocation({ provider: 'aws' })).toBeUndefined();
  });

  it('keeps the periods within a second and a week', () => {
    expect(checkLocation({ provider: 'aws', backupSyncPeriod: '1m' })).toBeUndefined();
    expect(checkLocation({ provider: 'aws', backupSyncPeriod: '0s' })).toMatch(/between/);
    expect(checkLocation({ provider: 'aws', validationFrequency: '169h' })).toMatch(/between/);
  });
});

describe('splitCredential', () => {
  const input = (credential?: object) => ({ provider: 'aws', credential });

  it('holds credential text as transient and stores only where it goes', () => {
    const out = splitCredential('vfm-bsl', 'primary', input({ content: 'secret-text' }));
    expect(out.secretRef).toEqual({ name: 'vfm-bsl-primary', key: 'cloud' });
    expect(out.rotatesSecret).toBe(true);
    expect(out.transient?.credential?.toString()).toBe('secret-text');
    // Nothing that is to be stored carries the text.
    expect(
      JSON.stringify({ secretRef: out.secretRef, rotatesSecret: out.rotatesSecret }),
    ).not.toContain('secret-text');
  });

  it('honours a chosen Secret name and key', () => {
    const out = splitCredential(
      'vfm-bsl',
      'p',
      input({ content: 'x', secretName: 'mine', key: 'k' }),
    );
    expect(out.secretRef).toEqual({ name: 'mine', key: 'k' });
  });

  it('references an existing Secret without holding anything', () => {
    const out = splitCredential(
      'vfm-bsl',
      'p',
      input({ secretName: 'cloud-credentials', key: 'cloud' }),
    );
    expect(out).toEqual({ secretRef: { name: 'cloud-credentials', key: 'cloud' } });
  });

  it('keeps the Secret a location already uses when the request says nothing', () => {
    const existing = { name: 'old', key: 'k' };
    expect(splitCredential('vfm-bsl', 'p', input(), existing)).toEqual({ secretRef: existing });
    expect(splitCredential('vfm-bsl', 'p', input())).toEqual({});
  });
});

describe('what the agent receives', () => {
  const payload = {
    name: 'primary',
    spec: {
      provider: 'aws',
      bucket: 'b',
      prefix: 'p',
      config: { region: 'r' },
      accessMode: 'ReadWrite',
    },
    secretRef: { name: 'vfm-bsl-primary', key: 'cloud' },
    rotatesSecret: true,
  };

  it('carries the held credential to the agent', () => {
    const { upsertBsl } = buildUpsertBsl(payload, { credential: Buffer.from('abc') });
    expect(Buffer.from(upsertBsl?.credential?.content ?? []).toString()).toBe('abc');
    expect(upsertBsl?.credential?.ref).toEqual({ name: 'vfm-bsl-primary', key: 'cloud' });
    expect(upsertBsl?.spec?.credential).toEqual({ name: 'vfm-bsl-primary', key: 'cloud' });
  });

  it('refuses to build a command whose credential is no longer held', () => {
    expect(() => buildUpsertBsl(payload)).toThrow(TransientUnavailableError);
    expect(() => buildUpsertVsl({ ...payload, spec: { provider: 'aws' } }, {})).toThrow(
      TransientUnavailableError,
    );
  });

  it('sends no credential when none was given', () => {
    const { rotatesSecret: _r, ...reference } = payload;
    expect(buildUpsertBsl(reference).upsertBsl?.credential).toBeUndefined();
  });

  it('builds the small commands', () => {
    expect(buildSetDefaultBsl({ name: 'a' })).toEqual({ setDefaultBsl: { name: 'a' } });
    expect(buildDeleteLocation('deleteVsl')({ name: 'a' })).toEqual({ deleteVsl: { name: 'a' } });
    expect(createSnapshotLocationBody.safeParse({ name: 'a', provider: 'aws' }).success).toBe(true);
  });
});
