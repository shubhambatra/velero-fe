import { Link } from '@tanstack/react-router';
import { useEffect, type ReactElement, type ReactNode } from 'react';

import { PRODUCT_NAME, PRODUCT_SHORT_NAME } from '@vfm/shared';

import { HealthIndicator } from '@/components/health-indicator';
import { OrgSwitcher } from '@/components/org-switcher';
import { ToastProvider } from '@/components/toasts';
import { useLiveUpdates, useStreamStatus } from '@/lib/events';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { useWaitingCount } from '@/lib/approvals';
import { canAdminister } from '@/lib/types';
import { useOrgs, useSession } from '@/lib/session';

const MAIN_CONTENT_ID = 'main-content';

/**
 * Application chrome: banner, navigation, main region (PLAN.md §16, Day 3).
 *
 * Accessibility baseline for every page built on top of this (PLAN.md §11.2):
 * real landmark elements rather than styled divs, a skip link as the first
 * focusable element, and a `main` that can take focus so the skip link
 * actually moves the caret.
 */
const ADMIN_LINKS = [
  { to: '/admin/members', label: 'Members' },
  { to: '/admin/teams', label: 'Teams' },
  { to: '/admin/sso', label: 'Single sign-on' },
  { to: '/admin/security', label: 'Security' },
  { to: '/admin/alerts', label: 'Alerts' },
  { to: '/admin/audit', label: 'Audit log' },
] as const;

export function AppShell({ children }: { children: ReactNode }): ReactElement {
  const session = useSession();
  const { active } = useOrgs(session.status === 'ready');
  const count = useWaitingCount(active?.id, session.status === 'ready' && active !== undefined);
  const waiting = count.data?.waiting ?? 0;
  const showAdmin = session.status === 'ready' && canAdminister(active?.orgRole);
  // One live stream for the active organization, for the whole signed-in app.
  useLiveUpdates(session.status === 'ready' ? active?.id : undefined);
  const stream = useStreamStatus();
  useEffect(() => {
    // PRODUCT_NAME in @vfm/shared is the single source of the product name
    // (PLAN.md §0); index.html can only carry a static copy for first paint.
    document.title = PRODUCT_NAME;
  }, []);

  return (
    <ToastProvider>
      <div className="min-h-screen bg-background text-foreground">
        <a
          href={`#${MAIN_CONTENT_ID}`}
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-control focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-card-foreground"
        >
          Skip to content
        </a>

        <header className="flex h-14 items-center gap-3 border-b border-border px-4">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
          >
            {PRODUCT_SHORT_NAME}
          </span>
          {/* Hidden only on phones; §11.2 requires the layout to work down to tablet. */}
          <span className="hidden text-base font-semibold sm:inline">{PRODUCT_NAME}</span>

          <div className="ml-auto flex items-center gap-2">
            {session.status === 'ready' && <OrgSwitcher email={session.user.email} />}
            {session.status === 'ready' && active !== undefined && (
              <span
                role="status"
                className="text-xs text-muted-foreground"
                title={
                  stream === 'live'
                    ? 'Updates arrive as they happen.'
                    : 'Live updates are not connected; this page refreshes every few seconds instead.'
                }
              >
                {stream === 'live'
                  ? 'Live'
                  : stream === 'offline'
                    ? 'Updates paused'
                    : 'Reconnecting…'}
              </span>
            )}
            <HealthIndicator />
            <ThemeToggle />
          </div>
        </header>

        <div className="flex flex-col md:flex-row">
          <nav
            aria-label="Main"
            className="flex gap-1 overflow-x-auto border-b border-border p-3 md:w-56 md:shrink-0 md:flex-col md:overflow-x-visible md:border-b-0 md:border-r"
          >
            <Link
              to="/"
              className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
              activeProps={{
                className: 'bg-accent text-accent-foreground',
                'aria-current': 'page',
              }}
            >
              Overview
            </Link>

            {session.status === 'ready' && active !== undefined && (
              <Link
                to="/clusters"
                className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
                activeProps={{
                  className: 'bg-accent text-accent-foreground',
                  'aria-current': 'page',
                }}
              >
                Clusters
              </Link>
            )}

            {session.status === 'ready' && active !== undefined && (
              <Link
                to="/reports"
                className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
                activeProps={{
                  className: 'bg-accent text-accent-foreground',
                  'aria-current': 'page',
                }}
              >
                Reports
              </Link>
            )}

            {session.status === 'ready' && active !== undefined && (
              <Link
                to="/approvals"
                className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
                activeProps={{
                  className: 'bg-accent text-accent-foreground',
                  'aria-current': 'page',
                }}
              >
                Approvals
                {waiting > 0 && (
                  <span
                    className="rounded-full bg-destructive px-2 text-xs text-destructive-foreground"
                    aria-label={`${waiting.toString()} waiting for you`}
                  >
                    {waiting}
                  </span>
                )}
              </Link>
            )}

            {session.status === 'ready' && active !== undefined && (
              <Link
                to="/tokens"
                className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
                activeProps={{
                  className: 'bg-accent text-accent-foreground',
                  'aria-current': 'page',
                }}
              >
                API tokens
              </Link>
            )}

            {showAdmin &&
              ADMIN_LINKS.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
                  activeProps={{
                    className: 'bg-accent text-accent-foreground',
                    'aria-current': 'page',
                  }}
                >
                  {link.label}
                </Link>
              ))}

            {session.status === 'ready' && session.user.isPlatformAdmin && (
              <Link
                to="/admin/orgs/new"
                className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
                activeProps={{
                  className: 'bg-accent text-accent-foreground',
                  'aria-current': 'page',
                }}
              >
                New organization
              </Link>
            )}
          </nav>

          <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex-1 p-4 md:p-6">
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
