import { z } from 'zod';

/**
 * Request schemas for `/auth/*` (PLAN.md §10 uses zod at the REST boundary,
 * §12.1 requires validation at every boundary).
 *
 * Bounds are on every string. An unbounded email or password field is a cheap
 * way to make the server do work on an attacker's behalf — argon2id reads the
 * whole password, and a 10 MB one would tie up a worker.
 */

const email = z
  .email()
  .trim()
  .min(3)
  .max(254) // RFC 5321 limit on a forward path.
  .transform((value) => value.toLowerCase());

export const loginSchema = z.object({
  email,
  // Not length-validated beyond a sane cap: the policy applies when a
  // password is *set*, and enforcing it at login would tell a caller whether a
  // stored password meets the current rules.
  password: z.string().min(1).max(1_024),
});

export type LoginDto = z.infer<typeof loginSchema>;

export const setupSchema = z.object({
  token: z.string().min(1).max(512),
  email,
  password: z.string().min(1).max(1_024),
  name: z.string().trim().min(1).max(200).optional(),
});

export type SetupDto = z.infer<typeof setupSchema>;

/**
 * A second factor: either a six-digit TOTP code or a recovery code.
 *
 * One field rather than two, because the caller should not have to declare
 * which kind it is — the server tells them apart by shape. The cap is generous
 * enough for a grouped recovery code with its dashes.
 */
export const mfaCodeSchema = z.object({
  code: z.string().trim().min(6).max(64),
});

export type MfaCodeDto = z.infer<typeof mfaCodeSchema>;

/**
 * Sudo re-authentication (PLAN.md §8.3 line 405: "password or MFA").
 *
 * Exactly one of the two must be supplied. Accepting both and preferring one
 * would make the weaker factor sufficient whenever the client sent it.
 */
export const sudoSchema = z
  .object({
    password: z.string().min(1).max(1_024).optional(),
    code: z.string().trim().min(6).max(64).optional(),
  })
  .refine(
    (value) => (value.password === undefined) !== (value.code === undefined),
    'supply either a password or a second-factor code, not both',
  );

export type SudoDto = z.infer<typeof sudoSchema>;
