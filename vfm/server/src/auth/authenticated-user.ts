import type { SessionRecord } from './session.service';

/**
 * The caller, as resolved for the current request.
 *
 * Deliberately a narrow projection of the `users` row: nothing here is
 * sensitive, so it is safe to log (after redaction) and to attach to audit
 * events. `passwordHash` and `mfaSecretEncrypted` must never reach it.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  isPlatformAdmin: boolean;
  mfaEnabled: boolean;
}

/** Everything the request carries about an authenticated caller. */
export interface RequestSession extends SessionRecord {
  id: string;
}

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
    session?: RequestSession;
  }
}
