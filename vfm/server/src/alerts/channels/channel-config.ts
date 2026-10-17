import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { checkUrl, type EgressPolicy } from './egress';

export const CHANNEL_TYPES = ['EMAIL', 'WEBHOOK', 'SLACK_WEBHOOK'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

const email = z.email().trim().max(254);
const url = z.string().trim().min(1).max(2048);

/** What a person sends when making a channel. The signing secret is ours to make, not theirs. */
export const CONFIG_INPUT = {
  EMAIL: z.object({ to: z.array(email).min(1).max(20) }).strict(),
  WEBHOOK: z.object({ url }).strict(),
  SLACK_WEBHOOK: z.object({ url }).strict(),
} as const;

/** What is stored, encrypted. */
export type ChannelConfig =
  | { type: 'EMAIL'; to: string[] }
  | { type: 'WEBHOOK'; url: string; secret: string }
  | { type: 'SLACK_WEBHOOK'; url: string };

export const newSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;

/** The destination as a reader may see it: where, never the path or query that may be a credential. */
export function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

export interface ChannelView {
  to?: string[];
  /** Scheme and host of the destination. The rest of a Slack URL is the credential. */
  destination?: string;
  signed?: boolean;
}

export const viewOf = (config: ChannelConfig): ChannelView =>
  config.type === 'EMAIL'
    ? { to: config.to }
    : config.type === 'WEBHOOK'
      ? { destination: originOf(config.url), signed: true }
      : { destination: originOf(config.url) };

/** Validates the part of a request that is a destination; returns a sentence when it is refused. */
export function checkInput(
  type: ChannelType,
  raw: unknown,
  policy: EgressPolicy,
): { ok: true; value: { to?: string[]; url?: string } } | { ok: false; message: string } {
  const parsed = CONFIG_INPUT[type].safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues
        .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
        .join('; '),
    };
  }
  const value = parsed.data as { to?: string[]; url?: string };
  if (value.url !== undefined) {
    const refusal = checkUrl(value.url, policy);
    if (refusal !== null) return { ok: false, message: `url: ${refusal}` };
  }
  return { ok: true, value };
}

/** Rebuilds a stored config from decrypted JSON, or null when it is not one (never trust a column). */
export function readConfig(type: ChannelType, json: string): ChannelConfig | null {
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (type === 'EMAIL' && Array.isArray(v.to) && v.to.every((x) => typeof x === 'string')) {
      return { type, to: v.to };
    }
    if (type === 'WEBHOOK' && typeof v.url === 'string' && typeof v.secret === 'string') {
      return { type, url: v.url, secret: v.secret };
    }
    if (type === 'SLACK_WEBHOOK' && typeof v.url === 'string') {
      return { type, url: v.url };
    }
  } catch {
    // Falls through.
  }
  return null;
}
