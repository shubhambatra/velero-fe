import { describe, expect, it } from 'vitest';

import { isSensitiveKey, redact, REDACTED } from './redact';

describe('isSensitiveKey', () => {
  it('matches credential-shaped keys regardless of casing or separators', () => {
    for (const key of [
      'password',
      'Password',
      'PASSWORD',
      'secretAccessKey',
      'secret_access_key',
      'secret-access-key',
      'aws_secret_access_key',
      'Authorization',
      'apiKey',
      'api_key',
      'privateKey',
      'passphrase',
      'totpSecret',
      'mfaSecret',
      'recoveryCodes',
      'csrfToken',
      'sessionKey',
      'bearerToken',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('keeps references to secrets, which are diagnostics rather than secrets', () => {
    // PLAN.md §5.3 syncs only the secret name/key reference for a BSL, and an
    // operator needs to see which one a location points at.
    for (const key of [
      'secretName',
      'secretRef',
      'secretKeyRef',
      'credentialName',
      'mfaEnabled',
      'mfaRequired',
      'tokenPrefix',
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('does not match unrelated keys', () => {
    for (const key of [
      'name',
      'namespace',
      'phase',
      'ttl',
      'storageLocation',
      'includedResources',
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('redact', () => {
  it('leaves primitives alone', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('replaces sensitive values while preserving structure', () => {
    const input = {
      name: 'daily-backup',
      credentials: { accessKeyID: 'AKIA...', secretAccessKey: 'super-secret' },
      spec: { storageLocation: 'default', ttl: '720h' },
    };

    expect(redact(input)).toStrictEqual({
      name: 'daily-backup',
      // The whole credentials object sits under a sensitive key, so it goes as
      // a unit — no chance of a child field escaping.
      credentials: REDACTED,
      spec: { storageLocation: 'default', ttl: '720h' },
    });
  });

  it('redacts inside arrays and nested objects', () => {
    const input = {
      locations: [
        { name: 'a', config: { password: 'one' } },
        { name: 'b', config: { password: 'two' } },
      ],
    };

    expect(redact(input)).toStrictEqual({
      locations: [
        { name: 'a', config: { password: REDACTED } },
        { name: 'b', config: { password: REDACTED } },
      ],
    });
  });

  it('does not mutate its input', () => {
    const input = { password: 'keep-me' };
    redact(input);
    expect(input.password).toBe('keep-me');
  });

  it('summarises buffers rather than printing key material', () => {
    expect(redact({ data: Buffer.from('private key bytes') })).toStrictEqual({
      data: '[BUFFER 17B]',
    });
  });

  it('serialises dates and errors into something loggable', () => {
    const at = new Date('2026-10-14T00:00:00.000Z');
    expect(redact({ at })).toStrictEqual({ at: '2026-10-14T00:00:00.000Z' });
    expect(redact(new Error('boom'))).toStrictEqual({ name: 'Error', message: 'boom' });
  });

  it('survives circular references', () => {
    const node: Record<string, unknown> = { name: 'loop' };
    node.self = node;

    expect(redact(node)).toStrictEqual({ name: 'loop', self: '[CIRCULAR]' });
  });

  it('truncates pathologically deep structures instead of overflowing the stack', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 50; i += 1) {
      deep = { nested: deep };
    }

    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain('[TRUNCATED]');
  });

  it('redacts Map keys that look sensitive', () => {
    const input = new Map<string, unknown>([
      ['token', 'abc'],
      ['name', 'visible'],
    ]);

    expect(redact(input)).toStrictEqual({ token: REDACTED, name: 'visible' });
  });

  it('never leaves a known credential substring in its output', () => {
    // Guards the property the grep test in PLAN.md §16 day 27 relies on.
    const serialised = JSON.stringify(
      redact({
        awsSecretAccessKey: 'AKIAIOSFODNN7EXAMPLE',
        bslCredentials: { password: 'hunter2' },
        nested: [{ apiKey: 'vfm_livetoken' }],
      }),
    );

    expect(serialised).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('vfm_livetoken');
  });
});
