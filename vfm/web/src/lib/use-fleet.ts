import { useQuery } from '@tanstack/react-query';

import { api } from './client';
import { useRefreshInterval } from './events';
import type { FleetCluster } from './fleet';

/** `GET /orgs/{org}/fleet` for the active organization: the one query behind the overview, the switcher and the fleet lists. */
export function useFleet(orgId: string | undefined) {
  const interval = useRefreshInterval();
  return useQuery({
    queryKey: ['org', orgId, 'fleet'],
    enabled: orgId !== undefined,
    refetchInterval: interval,
    queryFn: ({ signal }) =>
      api<{ clusters: FleetCluster[] }>(`/orgs/${orgId ?? ''}/fleet`, { signal }),
  });
}
