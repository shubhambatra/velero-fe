import { useQuery } from '@tanstack/react-query';

import { api } from './client';

/** `cluster`: everywhere; `scoped`: only in some namespaces; `none`: not at all. */
export type Level = 'cluster' | 'scoped' | 'none';

/**
 * What the signed-in user may do on a cluster, to show an action disabled with its
 * reason (PLAN.md §11.2). A hint only: the server authorizes every request itself.
 */
export function useAccess(orgId: string, clusterId: string) {
  const query = useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'access'],
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      api<{ access?: Partial<Record<string, Level>>; blocked?: Record<string, string> }>(
        `/orgs/${orgId}/clusters/${clusterId}/access`,
        {
          signal,
        },
      ),
  });
  // Unknown until answered (or if the answer is malformed): callers treat that as "not yet known",
  // never as a refusal, because the server decides each request anyway.
  const level = (permission: string): Level | undefined => query.data?.access?.[permission];
  /** Why an action is unavailable: the agent's policy when that is the cause, otherwise the missing permission. */
  const why = (permission: string): string =>
    query.data?.blocked?.[permission] ?? lacks(permission);
  return { loaded: query.data?.access !== undefined, level, why };
}

/** The sentence for an action the user lacks. */
export const lacks = (permission: string): string =>
  `You need the ${permission} permission on this cluster for this.`;
