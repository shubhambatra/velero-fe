import { z } from 'zod';

const labelKey = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);

export const clusterNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'letters, digits, space, dot, underscore and dash only');

export const createClusterSchema = z.object({
  name: clusterNameSchema,
  labels: z
    .record(labelKey, z.string().max(255))
    .refine((l) => Object.keys(l).length <= 50)
    .optional(),
});

export const updateClusterSchema = z
  .object({
    name: clusterNameSchema.optional(),
    labels: z
      .record(labelKey, z.string().max(255))
      .refine((l) => Object.keys(l).length <= 50)
      .optional(),
    // `https://grafana.example/d/abc?var-cluster={cluster}`; null clears it.
    grafanaUrlTemplate: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .nullable()
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to update');

export const reissueSchema = z.object({
  /** Allow the next agent to enroll from a different cluster than the last one. */
  resetFingerprint: z.boolean().default(false),
});
