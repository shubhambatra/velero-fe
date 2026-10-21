/**
 * The single redaction function required by PLAN.md §12.1.
 *
 * It must be applied before logging, before writing `commands.payload`
 * (PLAN.md §9) and before writing audit `details`. Object-storage credentials
 * for a BackupStorageLocation pass through the control plane exactly once, in
 * transit, and must never be persisted anywhere (PLAN.md §6, §12.1) — this is
 * the chokepoint that enforces it.
 *
 * Design notes:
 * - Matching is on the *key*, case-insensitively, by substring, because the
 *   shapes we redact come from three different sources (REST payloads, Velero
 *   specs, agent messages) and do not share a naming convention.
 * - Redaction is recursive and structure-preserving: a reviewer reading a
 *   redacted audit entry should still see what the request looked like.
 * - Fail closed: an unknown key holding something credential-shaped is better
 *   redacted by key pattern than printed, so the pattern list is broad.
 */

export const REDACTED = '[REDACTED]';

/**
 * Key substrings that mark a value as sensitive. Keep this list broad; the cost
 * of over-redacting a log line is far lower than leaking a credential.
 */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'secretkey',
  'secret_key',
  'sessionkey',
  'session_key',
  'privatekey',
  'private_key',
  'passphrase',
  'mfa',
  'totp',
  'otp',
  'recoverycode',
  'recovery_code',
  'signature',
  'bearer',
  'csrf',
  'salt',
  'certkey',
] as const;

/**
 * Keys that contain a sensitive substring but are not themselves secret.
 * Without these, useful diagnostics disappear: knowing *which* secret a BSL
 * refers to is exactly what an operator needs, and the reference is not the
 * credential (PLAN.md §5.3 syncs the reference only).
 */
const ALLOWED_KEYS = new Set([
  'secretname',
  'secretref',
  'secretkeyref',
  'tokenname',
  'credentialname',
  'credentialsname',
  'hastoken',
  'hassecret',
  'tokenprefix',
  'mfaenabled',
  'mfarequired',
  'secretcount',
  'tokencount',
]);

const MAX_DEPTH = 12;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

/** Whether a value stored under `key` must be replaced with {@link REDACTED}. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (ALLOWED_KEYS.has(normalized)) {
    return false;
  }
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(normalizeKey(pattern)));
}

/**
 * Returns a structural copy of `value` with every sensitive field replaced.
 *
 * Non-plain objects (Date, Buffer, Error, class instances) are not traversed —
 * they are returned as-is when safe to render, or summarised. Cycles and
 * excessive nesting are handled so this can never be the reason a request dies.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return '[TRUNCATED]';
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  // Buffers are almost always key material or log bytes in this codebase;
  // report the size rather than the contents.
  if (Buffer.isBuffer(value)) {
    return `[BUFFER ${value.byteLength.toString()}B]`;
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, seen));
    }

    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.entries()) {
        const name = String(key);
        out[name] = isSensitiveKey(name) ? REDACTED : redactValue(item, depth + 1, seen);
      }
      return out;
    }

    if (value instanceof Set) {
      return [...value].map((item) => redactValue(item, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Pino redaction paths for the fields that arrive on every HTTP log line.
 * `redact()` covers payloads we construct; this covers what the logger adds
 * on its own.
 */
export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.token',
  'req.body.credentials',
] as const;
