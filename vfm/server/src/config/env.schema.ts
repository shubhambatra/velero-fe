import { z } from 'zod';

/**
 * Environment contract for the control plane.
 *
 * PLAN.md §4.2 requires a zod-validated config module, and §12.1 requires that
 * every secret come from the environment or a Kubernetes Secret — never from a
 * file committed to git. Validation failures abort startup: a control plane
 * running with a half-configured security posture is worse than one that is
 * down.
 *
 * Only variables actually consumed today are listed. Each milestone adds its
 * own, so an operator is never asked to set something that does nothing.
 */

const port = z.coerce.number().int().min(1).max(65_535);

/** A 32-byte key supplied as base64. The value is never echoed on failure. */
const base64Key32 = z
  .string()
  .min(1)
  .refine(
    (value) => Buffer.from(value, 'base64').length === 32,
    'must be 32 bytes encoded as base64',
  );

/** Variables whose values must never be logged or echoed back (PLAN.md §12.1). */
export const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'VFM_MASTER_KEY',
  'VFM_MASTER_KEY_PREVIOUS',
  'SMTP_PASSWORD',
] as const;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Public HTTP listener for the REST API and SSE. */
  PORT: port.default(3000),

  /**
   * Metrics listener. PLAN.md §10 requires Prometheus metrics on a separate
   * port that is not exposed publicly, so it binds independently of PORT.
   */
  METRICS_PORT: port.default(9090),

  /** Bind address. Defaults to all interfaces because the normal deployment is a container. */
  HOST: z.string().min(1).default('0.0.0.0'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /**
   * Whether to believe `X-Forwarded-For`, and how far back.
   *
   * Brute-force protection keys on the client address (PLAN.md §8.3), so this
   * has to be deliberate: trusting the header unconditionally lets any caller
   * set it and walk around the per-IP limit, while not trusting it behind a
   * load balancer collapses every client onto the proxy's address and locks
   * everyone out together.
   *
   * `false` (default) trusts nothing. A number is the count of trusted proxy
   * hops — `1` is correct for a single Ingress or load balancer. A string is
   * passed through to Express's `trust proxy` for subnet forms such as
   * `loopback` or a CIDR.
   */
  TRUST_PROXY: z.string().default('false'),

  /**
   * Pretty-printed logs are a development convenience only; production emits
   * structured JSON (PLAN.md §4.2).
   */
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),

  REDIS_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
      message: 'must be a redis:// or rediss:// connection string',
    }),

  /**
   * Key-encryption key for the `*_encrypted` columns of PLAN.md §9: 32 bytes,
   * base64-encoded. Generate with `openssl rand -base64 32`.
   *
   * **Required from M1 day 5**, where `users.mfa_secret_encrypted` becomes the
   * first encrypted column. Starting without it would mean either storing a
   * TOTP secret in the clear or failing at the first write, so startup refuses
   * instead.
   */
  VFM_MASTER_KEY: base64Key32,

  /**
   * Previously used key-encryption keys, comma-separated, accepted for
   * **decryption only**.
   *
   * This is what makes the key rotation §9 asks for a non-event: deploy the
   * new key as `VFM_MASTER_KEY` with the old one listed here, let the rewrap
   * job work through the stored ciphertexts, then remove it. Without the old
   * key present, every row encrypted under it becomes unreadable.
   */
  VFM_MASTER_KEY_PREVIOUS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .refine(
      (keys) => keys.every((key) => Buffer.from(key, 'base64').length === 32),
      'every key must be 32 bytes encoded as base64',
    ),

  /**
   * Externally reachable base URL of the web app, used to build the links in
   * emails (invitations). No trailing slash is required; one is tolerated.
   */
  PUBLIC_URL: z
    .url()
    .default('http://localhost:5173')
    .transform((value) => value.replace(/\/+$/, '')),

  /**
   * Outbound SMTP (PLAN.md §4.2: nodemailer over SMTP "so it works
   * air-gapped"). Optional as a group: when `SMTP_HOST` is unset the mailer
   * reports itself unconfigured and anything that must send mail — an
   * invitation — fails loudly instead of pretending to have sent it.
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: port.default(587),
  /** Implicit TLS (port 465 style). STARTTLS is negotiated automatically otherwise. */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(3).default('Velero Fleet Manager <no-reply@localhost>'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates `process.env`, throwing an error that names every offending
 * variable but never prints its value — the value is frequently the secret.
 */
export function validateEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues
    .map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `  ${key}: ${issue.message}`;
    })
    .sort();

  throw new Error(`invalid environment configuration:\n${problems.join('\n')}`);
}
