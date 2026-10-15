import { createRoute } from '@tanstack/react-router';

import { RequireAdmin, RequireSession } from '@/components/require-session';
import { LoginPage } from '@/pages/login-page';
import { MfaPage } from '@/pages/mfa-page';
import { SetupPage } from '@/pages/setup-page';
import { AuditPage } from '@/pages/admin/audit-page';
import { MembersPage } from '@/pages/admin/members-page';
import { SecurityPage } from '@/pages/admin/security-page';
import { SsoPage } from '@/pages/admin/sso-page';
import { TeamsPage } from '@/pages/admin/teams-page';

import { rootRoute } from './root-route';

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { sso?: string } =>
    typeof search.sso === 'string' ? { sso: search.sso } : {},
  component: function Login() {
    const { sso } = loginRoute.useSearch();
    return <LoginPage ssoFailed={sso === 'failed'} />;
  },
});

export const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupPage,
});

export const mfaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mfa',
  component: MfaPage,
});

function adminRoute(
  path: string,
  render: (orgId: string) => React.ReactNode,
): ReturnType<typeof createRoute> {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => (
      <RequireSession>
        <RequireAdmin>{render}</RequireAdmin>
      </RequireSession>
    ),
  }) as unknown as ReturnType<typeof createRoute>;
}

export const membersRoute = adminRoute('/admin/members', (id) => <MembersPage orgId={id} />);
export const teamsRoute = adminRoute('/admin/teams', (id) => <TeamsPage orgId={id} />);
export const ssoRoute = adminRoute('/admin/sso', (id) => <SsoPage orgId={id} />);
export const securityRoute = adminRoute('/admin/security', (id) => <SecurityPage orgId={id} />);
export const auditRoute = adminRoute('/admin/audit', (id) => <AuditPage orgId={id} />);
