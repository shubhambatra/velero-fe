import { z } from 'zod';

/**
 * Request schemas for `/orgs/*` and `/invites/*` (PLAN.md §10, §12.1).
 * Every string is bounded; see auth.dto.ts for why.
 */

const email = z
  .email()
  .trim()
  .min(3)
  .max(254)
  .transform((value) => value.toLowerCase());

const orgRole = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

export const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // URL- and DNS-safe: it ends up in paths and, later, in hostnames.
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'lowercase letters, digits and hyphens only'),
});

export const updateOrgSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    mfaRequired: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.mfaRequired !== undefined, 'nothing to update');

export const setActiveOrgSchema = z.object({ orgId: z.uuid() });

export const changeRoleSchema = z.object({ orgRole });

export const createInviteSchema = z.object({ email, orgRole: orgRole.default('MEMBER') });

export const acceptInviteSchema = z.object({ token: z.string().min(16).max(256) });

export const registerViaInviteSchema = z.object({
  token: z.string().min(16).max(256),
  password: z.string().min(1).max(1_024),
  name: z.string().trim().min(1).max(200).optional(),
});

export const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

export const updateTeamSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, 'nothing to update');

export const orgIdParam = z.uuid();
