import { z } from 'zod';

import type { OrgRole } from '@prisma/client';

/**
 * Per-organization MFA enforcement — PLAN.md §8.3: "MFA is **enforceable per
 * org** (default: required for Owner/Admin)".
 *
 * Read as two rules:
 *
 *  - Owners and Admins **always** need a second factor. They can grant
 *    themselves Cluster Admin on every cluster in the org (§8.2), which means
 *    restore and delete on everything, so a stolen password alone must not be
 *    enough. This is the default the plan states and it is not configurable
 *    off — an org setting that could weaken it would be the first thing an
 *    attacker who got one admin password would change.
 *  - `mfaRequired` extends the same obligation to **every** member, for orgs
 *    that want it. Off by default so adopting the product does not begin with
 *    enrolling everyone.
 *
 * A user who owes a second factor can sign in and reach only the enrolment
 * endpoints until they have one; see `SessionGuard`.
 */

/** The §9 `organizations.settings` fields that exist so far. */
export const orgSettingsSchema = z.object({
  /** Require MFA of every member, not only Owners and Admins. */
  mfaRequired: z.boolean().default(false),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

/**
 * Parses a settings JSON blob.
 *
 * Unknown keys are dropped and malformed values fall back to the defaults, so
 * a row written by a newer version — or by hand — cannot take the process
 * down. Defaults live here rather than in the column default, so an existing
 * row never silently gains a permissive value when a new setting is added.
 */
export function parseOrgSettings(raw: unknown): OrgSettings {
  const result = orgSettingsSchema.safeParse(raw ?? {});
  return result.success ? result.data : orgSettingsSchema.parse({});
}

/** Roles that must always have a second factor, whatever the org setting says. */
const ALWAYS_REQUIRED: readonly OrgRole[] = ['OWNER', 'ADMIN'];

export interface MfaObligation {
  required: boolean;
  /** Why, for the UI to explain rather than merely refuse. */
  reason: 'org_role' | 'org_policy' | 'platform_admin' | null;
}

/**
 * Whether this user owes a second factor.
 *
 * Evaluated across every org they belong to: a Member in one org and an Admin
 * in another is an Admin somewhere, so the obligation applies. Taking the
 * union rather than the intersection is the only safe reading.
 */
export function mfaObligationFor(input: {
  isPlatformAdmin: boolean;
  memberships: { orgRole: OrgRole; settings: unknown }[];
}): MfaObligation {
  // A platform admin bootstraps organizations and is not granted by any org
  // (§8.1), so no org setting governs them. They are the most privileged
  // identity in the installation.
  if (input.isPlatformAdmin) {
    return { required: true, reason: 'platform_admin' };
  }

  if (input.memberships.some((m) => ALWAYS_REQUIRED.includes(m.orgRole))) {
    return { required: true, reason: 'org_role' };
  }

  if (input.memberships.some((m) => parseOrgSettings(m.settings).mfaRequired)) {
    return { required: true, reason: 'org_policy' };
  }

  return { required: false, reason: null };
}
