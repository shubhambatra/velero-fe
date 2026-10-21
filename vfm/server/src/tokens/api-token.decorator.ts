import { SetMetadata } from '@nestjs/common';

export const ALLOWS_API_TOKEN = 'vfm:allowsApiToken';

/**
 * Lets a route be called with `Authorization: Bearer vfm_…` (PLAN.md §8.3).
 *
 * **Opt-in**, unlike sessions. Many handlers assume a browser session — they
 * read its CSRF token, its re-authentication time, its active org — and a
 * token has none of those. Making acceptance explicit means a new route can
 * never be reachable by a long-lived credential by accident, and it keeps
 * account and credential management (passwords, MFA, tokens themselves) out of
 * reach of a stolen token.
 */
export const AllowsApiToken = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOWS_API_TOKEN, true);
