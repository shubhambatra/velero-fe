import { QueryClient } from '@tanstack/react-query';

import { ApiProblem } from '@/lib/api';

/** How long fleet metadata is considered fresh enough to reuse. */
const DEFAULT_STALE_TIME_MS = 30_000;

const MAX_QUERY_RETRIES = 2;

/**
 * Query defaults for the whole app (PLAN.md §4.3).
 *
 * Built per mount rather than as a module singleton so each test — and later
 * each authenticated session — starts with an empty cache. Cached fleet data
 * must never outlive a sign-out (PLAN.md §12.1 isolates orgs; a stale cache
 * would leak across them).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        // Retrying a 4xx cannot help: a 403 from RBAC, a 404, or a 422 are
        // all decisions, not blips. Only 5xx and transport failures retry.
        retry: (failureCount, error) => {
          if (error instanceof ApiProblem && error.status < 500) {
            return false;
          }
          return failureCount < MAX_QUERY_RETRIES;
        },
        // An operator who comes back to the tab wants current state, not
        // whatever the fleet looked like when they left it.
        refetchOnWindowFocus: true,
      },
      mutations: {
        // Every mutation in this product queues a command against a cluster
        // (PLAN.md §5.4). Automatic retries would risk duplicate backups and
        // restores; idempotency is handled explicitly per command instead.
        retry: 0,
      },
    },
  });
}
