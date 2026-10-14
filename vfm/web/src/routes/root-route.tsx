import { createRootRoute, Outlet } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { AppShell } from '@/components/app-shell';
import { NotFoundPage } from '@/pages/not-found-page';

/**
 * Routing is code-based rather than file-based (PLAN.md §4.3 picks TanStack
 * Router but not a flavour). Reasons: no generated route tree to keep in sync
 * or commit, and routes stay plain modules that a unit test can import and a
 * reviewer can read top to bottom.
 */
export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

function RootLayout(): ReactElement {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
