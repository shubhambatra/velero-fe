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
    allowBackupContentDownload: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.mfaRequired !== undefined ||
      v.allowBackupContentDownload !== undefined,
    'nothing to update',
  );

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

const clusterRole = z.enum(['VIEWER', 'OPERATOR', 'RESTORER', 'CLUSTER_ADMIN']);

/** A Kubernetes namespace name (RFC 1123 label); no wildcards in a scoped binding. */
const namespaceName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'a lowercase RFC 1123 namespace name');

export const createRoleBindingSchema = z.object({
  subjectType: z.enum(['USER', 'TEAM']),
  subjectId: z.uuid(),
  role: clusterRole,
  scope: z.discriminatedUnion('type', [
    z.object({ type: z.literal('CLUSTER') }),
    z.object({
      type: z.literal('NAMESPACES'),
      namespaces: z.array(namespaceName).min(1).max(100),
    }),
    z.object({
      type: z.literal('SELECTOR'),
      selector: z.object({
        matchLabels: z
          .record(z.string().min(1).max(63), z.string().max(63))
          .refine((m) => Object.keys(m).length > 0, 'at least one label is required'),
      }),
    }),
  ]),
});
