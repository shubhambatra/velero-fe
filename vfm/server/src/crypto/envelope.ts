import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope encryption for the `*_encrypted` columns of PLAN.md §9.
 *
 * ## Why an envelope rather than encrypting with the master key directly
 *
 * Every ciphertext gets its own random **data key** (DEK); the DEK is wrapped
 * with the **key-encryption key** (KEK) from `VFM_MASTER_KEY`. Two things fall
 * out of that:
 *
 *  - The KEK never encrypts user data, so the amount of data under any single
 *    key stays bounded — AES-GCM has a birthday bound on (key, nonce) reuse
 *    and this removes the question entirely.
 *  - Rotating the KEK means re-wrapping a short DEK, not re-encrypting every
 *    row. The §9 requirement to "support key rotation by storing a key ID with
 *    each ciphertext" is what makes that possible, and {@link needsRewrap}
 *    reports which rows are still on an old key.
 *
 * ## Key ids
 *
 * The key id is derived from the key material itself — the first 8 bytes of
 * its SHA-256 — rather than configured separately. An operator cannot
 * mislabel a key, two deployments given the same key agree on its id, and
 * nothing extra has to be kept in sync. It is not a secret: it identifies
 * which key to use, and 8 bytes of a hash of a 256-bit key reveals nothing
 * usable about it.
 *
 * ## Associated data
 *
 * Every call names the *context* the ciphertext belongs to — for example
 * `user.mfa_secret:<userId>`. That string is authenticated but not encrypted,
 * so a ciphertext lifted from one row and pasted into another fails to
 * decrypt instead of silently decrypting as someone else's secret.
 *
 * ## Wire format
 *
 * `vfm1.<keyId>.<wrapIv>.<wrapTag>.<wrappedDek>.<iv>.<tag>.<ciphertext>`
 *
 * Seven base64url fields after a version tag. Dotted rather than JSON so a
 * value is recognisable on sight in a database dump, cheap to parse, and
 * impossible to confuse with plaintext. The version tag is first so a future
 * format change is unambiguous.
 */

const VERSION = 'vfm1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size AES-GCM is specified for.
const TAG_BYTES = 16;
const KEY_ID_BYTES = 8;

export interface EnvelopeKey {
  /** Short, deterministic identifier derived from the key material. */
  id: string;
  key: Buffer;
}

/**
 * The keys this process can use.
 *
 * `primary` encrypts; every key in `all` can decrypt, which is what makes a
 * rotation possible without downtime: deploy the new key as primary with the
 * old one still listed, re-wrap in the background, then drop the old key.
 */
export interface Keyring {
  primary: EnvelopeKey;
  all: Map<string, EnvelopeKey>;
}

/** Thrown for every decryption failure, with no detail about which part failed. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Derives the stable id of a key from its material. */
export function keyIdFor(key: Buffer): string {
  return createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, KEY_ID_BYTES * 2);
}

/**
 * Builds a keyring from base64-encoded key material.
 *
 * The primary key is required and must be exactly 32 bytes; extra keys are
 * accepted for decryption only. A key that appears twice is collapsed, so
 * leaving the old value in place during a rotation is harmless.
 */
export function createKeyring(primaryBase64: string, previousBase64: string[] = []): Keyring {
  const primary = parseKey(primaryBase64, 'VFM_MASTER_KEY');

  const all = new Map<string, EnvelopeKey>([[primary.id, primary]]);
  previousBase64.forEach((material, index) => {
    const key = parseKey(material, `VFM_MASTER_KEY_PREVIOUS[${index.toString()}]`);
    all.set(key.id, key);
  });

  return { primary, all };
}

function parseKey(material: string, name: string): EnvelopeKey {
  const key = Buffer.from(material, 'base64');
  if (key.length !== KEY_BYTES) {
    // The length is reported; the value never is.
    throw new Error(
      `${name} must be ${KEY_BYTES.toString()} bytes encoded as base64, got ${key.length.toString()} bytes`,
    );
  }
  return { id: keyIdFor(key), key };
}

/**
 * Encrypts `plaintext` under the keyring's primary key.
 *
 * `context` is authenticated, not encrypted: pass something that identifies
 * where this ciphertext is going to live, so it cannot be relocated.
 */
export function encrypt(keyring: Keyring, plaintext: string, context: string): string {
  requireContext(context);

  // One fresh data key per ciphertext.
  const dek = randomBytes(KEY_BYTES);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // The DEK is wrapped under the KEK, bound to the same context and to the
  // key id, so a wrapped DEK cannot be moved either.
  const wrapIv = randomBytes(IV_BYTES);
  const wrapper = createCipheriv(ALGORITHM, keyring.primary.key, wrapIv, {
    authTagLength: TAG_BYTES,
  });
  wrapper.setAAD(Buffer.from(`${keyring.primary.id}:${context}`, 'utf8'));
  const wrappedDek = Buffer.concat([wrapper.update(dek), wrapper.final()]);
  const wrapTag = wrapper.getAuthTag();

  // The data key is finished with; do not leave it in memory any longer than
  // necessary. (Node may still have copies — this is hygiene, not a barrier.)
  dek.fill(0);

  return [
    VERSION,
    keyring.primary.id,
    b64(wrapIv),
    b64(wrapTag),
    b64(wrappedDek),
    b64(iv),
    b64(tag),
    b64(ciphertext),
  ].join('.');
}

/**
 * Decrypts a value produced by {@link encrypt}.
 *
 * Throws {@link DecryptionError} for a malformed value, an unknown key, a
 * failed authentication tag, or a context that does not match. The message
 * never says which, because the caller cannot act differently on any of them
 * and an attacker should not learn which check failed.
 */
export function decrypt(keyring: Keyring, envelope: string, context: string): string {
  requireContext(context);

  const parts = envelope.split('.');
  if (parts.length !== 8 || parts[0] !== VERSION) {
    throw new DecryptionError('malformed ciphertext');
  }

  const [, keyId, wrapIvB64, wrapTagB64, wrappedDekB64, ivB64, tagB64, ciphertextB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const envelopeKey = keyring.all.get(keyId);
  if (envelopeKey === undefined) {
    throw new DecryptionError(
      `ciphertext was encrypted with key ${keyId}, which this process does not have`,
    );
  }

  try {
    const unwrapper = createDecipheriv(ALGORITHM, envelopeKey.key, buf(wrapIvB64), {
      authTagLength: TAG_BYTES,
    });
    unwrapper.setAAD(Buffer.from(`${keyId}:${context}`, 'utf8'));
    unwrapper.setAuthTag(buf(wrapTagB64));
    const dek = Buffer.concat([unwrapper.update(buf(wrappedDekB64)), unwrapper.final()]);

    const decipher = createDecipheriv(ALGORITHM, dek, buf(ivB64), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(buf(tagB64));
    const plaintext = Buffer.concat([
      decipher.update(buf(ciphertextB64)),
      decipher.final(),
    ]).toString('utf8');

    dek.fill(0);
    return plaintext;
  } catch {
    // The cause is deliberately dropped: a tag mismatch, a context mismatch
    // and a corrupt payload must be indistinguishable to the caller.
    throw new DecryptionError('could not decrypt ciphertext');
  }
}

/**
 * Whether a ciphertext is still wrapped under a non-primary key.
 *
 * A rotation job walks the `*_encrypted` columns, decrypts and re-encrypts
 * whatever this returns true for, and the old key can then be retired.
 */
export function needsRewrap(keyring: Keyring, envelope: string): boolean {
  const keyId = envelope.split('.')[1];
  return keyId !== keyring.primary.id;
}

/** The key id a ciphertext was produced with, or null if it is unreadable. */
export function keyIdOf(envelope: string): string | null {
  const parts = envelope.split('.');
  if (parts.length !== 8 || parts[0] !== VERSION) {
    return null;
  }
  return parts[1] ?? null;
}

function requireContext(context: string): void {
  if (context === '') {
    // An empty context would authenticate nothing and silently permit a
    // ciphertext to be moved between rows.
    throw new Error('an encryption context is required');
  }
}

function b64(value: Buffer): string {
  return value.toString('base64url');
}

function buf(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}
