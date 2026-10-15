import { useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiProblem } from './api';
import { isRecord } from './guards';
import { api } from './client';
import type { MfaPendingReason, OrgSummary, User } from './types';

export type SessionState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'anonymous' }
  | { status: 'mfa'; reason: MfaPendingReason }
  | { status: 'ready'; user: User };

export const SESSION_KEY = ['session'] as const;
export const ORGS_KEY = ['orgs'] as const;

type SessionData =
  { kind: 'anonymous' } | { kind: 'mfa'; reason: MfaPendingReason } | { kind: 'ready'; user: User };

async function loadSession(signal: AbortSignal): Promise<SessionData> {
  try {
    const body = await api<unknown>('/auth/me', { signal });
    if (!isRecord(body) || !isRecord(body.user)) {
      throw new Error('Unexpected response from /auth/me');
    }
    return { kind: 'ready', user: body.user as unknown as User };
  } catch (error: unknown) {
    if (error instanceof ApiProblem) {
      if (error.status === 401) {
        return { kind: 'anonymous' };
      }
      if (error.status === 403 && error.mfaRequired) {
        return { kind: 'mfa', reason: error.mfaPendingReason ?? 'challenge' };
      }
    }
    throw error;
  }
}

export function useSession(): SessionState {
  const query = useQuery({ queryKey: SESSION_KEY, queryFn: ({ signal }) => loadSession(signal) });
  if (query.isPending) {
    return { status: 'loading' };
  }
  if (query.isError) {
    return { status: 'error', error: query.error };
  }
  const data = query.data;
  switch (data.kind) {
    case 'anonymous':
      return { status: 'anonymous' };
    case 'mfa':
      return { status: 'mfa', reason: data.reason };
    case 'ready':
      return { status: 'ready', user: data.user };
  }
}

/** Orgs the caller belongs to; only runs once the session is usable. */
export function useOrgs(enabled: boolean): {
  orgs: OrgSummary[];
  active: OrgSummary | undefined;
  isPending: boolean;
} {
  const query = useQuery({
    queryKey: ORGS_KEY,
    enabled,
    queryFn: ({ signal }) => api<{ orgs: OrgSummary[] }>('/me/orgs', { signal }),
  });
  const orgs = query.data?.orgs ?? [];
  return {
    orgs,
    active: orgs.find((o) => o.active) ?? orgs[0],
    isPending: enabled && query.isPending,
  };
}

/** Drops cached session and org data after login, logout or an MFA step. */
export function useResetSession(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: SESSION_KEY });
    await client.invalidateQueries({ queryKey: ORGS_KEY });
  };
}
