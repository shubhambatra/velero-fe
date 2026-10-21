import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createKeyring,
  decrypt,
  DecryptionError,
  encrypt,
  keyIdFor,
  keyIdOf,
  needsRewrap,
} from './envelope';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

const CONTEXT = 'user.mfa_secret:0192f2a0-0000-7000-8000-000000000001';

describe('createKeyring', () => {
  it('derives a stable key id from the key material', () => {
    const a = createKeyring(KEY_A);
    const b = createKeyring(KEY_A);

    // Deterministic, so two replicas given the same key agree without any
    // extra configuration to keep in sync.
    expect(a.primary.id).toBe(b.primary.id);
    expect(a.primary.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives different keys different ids', () => {
    expect(createKeyring(KEY_A).primary.id).not.toBe(createKeyring(KEY_B).primary.id);
  });

  it('rejects a key that is not 32 bytes, naming the variable but not the value', () => {
    const short = randomBytes(16).toString('base64');

    expect(() => createKeyring(short)).toThrow(/VFM_MASTER_KEY/);
    expect(() => createKeyring(short)).toThrow(/32 bytes/);
    // A plain substring check: base64 contains `+` and `/`, so building a RegExp from
    // random key material fails to compile a few percent of the time.
    let message = '';
    try {
      createKeyring(short);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(short.slice(0, 8));
  });

  it('accepts previous keys for decryption', () => {
    const keyring = createKeyring(KEY_A, [KEY_B]);

    expect(keyring.all.size).toBe(2);
    expect(keyring.primary.id).toBe(keyIdFor(Buffer.from(KEY_A, 'base64')));
  });

  it('collapses a previous key that is also the primary', () => {
    // Leaving the old value in VFM_MASTER_KEY_PREVIOUS after a rotation
    // completes must be harmless.
    expect(createKeyring(KEY_A, [KEY_A]).all.size).toBe(1);
  });
});

describe('encrypt and decrypt', () => {
  const keyring = createKeyring(KEY_A);

  it('round-trips a value', () => {
    const envelope = encrypt(keyring, 'JBSWY3DPEHPK3PXP', CONTEXT);

    expect(decrypt(keyring, envelope, CONTEXT)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('round-trips unicode and an empty string', () => {
    for (const plaintext of ['', 'naïve café 🔐', 'a'.repeat(5_000)]) {
      const envelope = encrypt(keyring, plaintext, CONTEXT);
      expect(decrypt(keyring, envelope, CONTEXT)).toBe(plaintext);
    }
  });

  it('never leaves the plaintext recoverable from the ciphertext', () => {
    const envelope = encrypt(keyring, 'JBSWY3DPEHPK3PXP', CONTEXT);

    expect(envelope).not.toContain('JBSWY3DPEHPK3PXP');
    // Nor base64 of it, which is the mistake an encode-only "encryption" makes.
    expect(envelope).not.toContain(Buffer.from('JBSWY3DPEHPK3PXP').toString('base64url'));
  });

  it('produces a different ciphertext every time', () => {
    const a = encrypt(keyring, 'same-secret', CONTEXT);
    const b = encrypt(keyring, 'same-secret', CONTEXT);

    // A fresh data key and nonce per call, so identical plaintexts do not
    // reveal that they are identical.
    expect(a).not.toBe(b);
    expect(decrypt(keyring, a, CONTEXT)).toBe(decrypt(keyring, b, CONTEXT));
  });

  it('writes a recognisable, versioned wire format', () => {
    const envelope = encrypt(keyring, 'x', CONTEXT);
    const parts = envelope.split('.');

    expect(parts).toHaveLength(8);
    expect(parts[0]).toBe('vfm1');
    expect(parts[1]).toBe(keyring.primary.id);
  });
});

describe('associated data binds a ciphertext to its location', () => {
  const keyring = createKeyring(KEY_A);

  it('refuses to decrypt under a different context', () => {
    const envelope = encrypt(keyring, 'JBSWY3DPEHPK3PXP', 'user.mfa_secret:user-a');

    // This is the attack it prevents: lifting the MFA secret ciphertext from
    // one user's row into another's.
    expect(() => decrypt(keyring, envelope, 'user.mfa_secret:user-b')).toThrow(DecryptionError);
  });

  it('refuses to decrypt under a different column', () => {
    const envelope = encrypt(keyring, 'secret', 'user.mfa_secret:user-a');

    expect(() => decrypt(keyring, envelope, 'oidc_provider.client_secret:user-a')).toThrow(
      DecryptionError,
    );
  });

  it('requires a non-empty context, which would otherwise authenticate nothing', () => {
    expect(() => encrypt(keyring, 'secret', '')).toThrow(/context is required/);
    expect(() => decrypt(keyring, 'vfm1.a.b.c.d.e.f.g', '')).toThrow(/context is required/);
  });
});

describe('tampering', () => {
  const keyring = createKeyring(KEY_A);

  it('rejects a modified ciphertext', () => {
    const envelope = encrypt(keyring, 'JBSWY3DPEHPK3PXP', CONTEXT);
    const parts = envelope.split('.');
    // Flip a whole byte of the decoded payload. Editing the last base64url
    // character instead is flaky: it carries only 4 meaningful bits, and
    // overwriting it with 'A' changes nothing about a quarter of the time.
    const payload = Buffer.from(parts[7] ?? '', 'base64url');
    payload[0] = (payload[0] ?? 0) ^ 0xff;
    parts[7] = payload.toString('base64url');

    expect(() => decrypt(keyring, parts.join('.'), CONTEXT)).toThrow(DecryptionError);
  });

  it('rejects a modified authentication tag', () => {
    const envelope = encrypt(keyring, 'JBSWY3DPEHPK3PXP', CONTEXT);
    const parts = envelope.split('.');
    parts[6] = Buffer.alloc(16, 1).toString('base64url');

    expect(() => decrypt(keyring, parts.join('.'), CONTEXT)).toThrow(DecryptionError);
  });

  it('rejects a swapped wrapped data key', () => {
    // Taking the wrapped DEK from one ciphertext and the payload from another
    // must not produce a readable value.
    const a = encrypt(keyring, 'secret-a', CONTEXT).split('.');
    const b = encrypt(keyring, 'secret-b', CONTEXT).split('.');
    const frankenstein = [...a.slice(0, 5), ...b.slice(5)].join('.');

    expect(() => decrypt(keyring, frankenstein, CONTEXT)).toThrow(DecryptionError);
  });

  it('rejects a malformed value without saying what was wrong', () => {
    for (const bad of ['', 'not-a-ciphertext', 'vfm1.too.few.parts', 'vfm0.a.b.c.d.e.f.g']) {
      expect(() => decrypt(keyring, bad, CONTEXT), bad).toThrow(DecryptionError);
    }
  });

  it('does not decrypt with the wrong key', () => {
    const envelope = encrypt(createKeyring(KEY_A), 'secret', CONTEXT);

    expect(() => decrypt(createKeyring(KEY_B), envelope, CONTEXT)).toThrow(
      /does not have|could not decrypt/,
    );
  });
});

describe('key rotation (PLAN.md §9)', () => {
  it('reads a ciphertext written under a retired key', () => {
    const old = createKeyring(KEY_B);
    const envelope = encrypt(old, 'JBSWY3DPEHPK3PXP', CONTEXT);

    // Mid-rotation: the new key is primary, the old one is still accepted.
    const rotated = createKeyring(KEY_A, [KEY_B]);

    expect(decrypt(rotated, envelope, CONTEXT)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('reports which ciphertexts still need re-wrapping', () => {
    const old = createKeyring(KEY_B);
    const stale = encrypt(old, 'secret', CONTEXT);

    const rotated = createKeyring(KEY_A, [KEY_B]);
    const fresh = encrypt(rotated, 'secret', CONTEXT);

    expect(needsRewrap(rotated, stale)).toBe(true);
    expect(needsRewrap(rotated, fresh)).toBe(false);
  });

  it('becomes unreadable once the old key is dropped, which is the point of listing it', () => {
    const envelope = encrypt(createKeyring(KEY_B), 'secret', CONTEXT);
    const afterRetirement = createKeyring(KEY_A);

    expect(() => decrypt(afterRetirement, envelope, CONTEXT)).toThrow(DecryptionError);
  });

  it('names the key a ciphertext needs, so an operator can tell what is missing', () => {
    const envelope = encrypt(createKeyring(KEY_B), 'secret', CONTEXT);
    const keyId = keyIdOf(envelope);

    expect(keyId).toBe(createKeyring(KEY_B).primary.id);
    expect(() => decrypt(createKeyring(KEY_A), envelope, CONTEXT)).toThrow(
      new RegExp(keyId ?? 'never'),
    );
  });

  it('reports null for the key id of an unreadable value', () => {
    expect(keyIdOf('garbage')).toBeNull();
  });
});
