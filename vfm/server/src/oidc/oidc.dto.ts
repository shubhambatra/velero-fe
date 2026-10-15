import { z } from 'zod';

const mapping = z.object({
  group: z.string().trim().min(1).max(256),
  teamId: z.uuid(),
});

export const mappingsSchema = z.array(mapping).max(200);

export type OidcMapping = z.infer<typeof mapping>;

const base = {
  name: z.string().trim().min(1).max(100),
  issuer: z.url().max(512),
  clientId: z.string().trim().min(1).max(256),
  groupClaim: z.string().trim().min(1).max(100).nullable().optional(),
  mappings: mappingsSchema.optional(),
  jitEnabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
};

export const createProviderSchema = z.object({
  ...base,
  clientSecret: z.string().min(1).max(2_048),
});

export const updateProviderSchema = z
  .object({
    name: base.name.optional(),
    issuer: base.issuer.optional(),
    clientId: base.clientId.optional(),
    groupClaim: base.groupClaim,
    mappings: base.mappings,
    jitEnabled: base.jitEnabled,
    enabled: base.enabled,
    /** Supplying it rotates the secret; omitting it leaves the stored one. */
    clientSecret: z.string().min(1).max(2_048).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');

export const callbackQuerySchema = z.object({
  state: z.string().min(16).max(256),
  // `code` is absent when the IdP sends back `error=…`.
  code: z.string().min(1).max(4_096).optional(),
  error: z.string().max(256).optional(),
});
