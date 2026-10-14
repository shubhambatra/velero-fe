import { createRoute } from '@tanstack/react-router';

import { OverviewPage } from '@/pages/overview-page';

import { rootRoute } from './root-route';

/**
 * Index route. It will become the org-scoped fleet overview
 * (`/orgs/{orgId}` per PLAN.md §10) once orgs exist in M1; keeping it at `/`
 * now avoids inventing an id scheme the server has not defined yet.
 */
export const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
});
