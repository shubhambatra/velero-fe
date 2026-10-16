import { createRouter } from '@tanstack/react-router';

import {
  auditRoute,
  clusterRoute,
  clustersRoute,
  loginRoute,
  membersRoute,
  createOrgRoute,
  inviteRoute,
  tokensRoute,
  mfaRoute,
  securityRoute,
  setupRoute,
  ssoRoute,
  teamsRoute,
} from '@/routes/auth-routes';
import { overviewRoute } from '@/routes/overview-route';
import { rootRoute } from '@/routes/root-route';

/** Exported so tests can mount the same tree with a memory history. */
export const routeTree = rootRoute.addChildren([
  overviewRoute,
  loginRoute,
  setupRoute,
  mfaRoute,
  membersRoute,
  createOrgRoute,
  tokensRoute,
  clusterRoute,
  clustersRoute,
  inviteRoute,
  teamsRoute,
  ssoRoute,
  securityRoute,
  auditRoute,
]);

export const router = createRouter({
  routeTree,
  // Preloading on hover/focus costs nothing here and will matter once routes
  // load fleet data (PLAN.md §11.1 pages are data-heavy).
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
