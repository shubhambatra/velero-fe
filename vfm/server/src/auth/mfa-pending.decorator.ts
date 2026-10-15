import { SetMetadata } from '@nestjs/common';

export const ALLOWS_MFA_PENDING = 'vfm:allowsMfaPending';

/**
 * Marks a route as reachable by a session that has passed the password check
 * but not yet its second factor.
 *
 * Only the MFA challenge itself, the enrolment endpoints and logout may carry
 * this. Everything else must be unreachable until the factor is satisfied,
 * which is what makes MFA an actual gate rather than a suggestion — see
 * `SessionGuard`.
 */
export const AllowsMfaPending = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOWS_MFA_PENDING, true);
