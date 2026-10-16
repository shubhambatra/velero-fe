import { createRoute } from '@tanstack/react-router';

import { RequireAdmin, RequireOrg, RequireSession } from '@/components/require-session';
import { LoginPage } from '@/pages/login-page';
import { MfaPage } from '@/pages/mfa-page';
import { SetupPage } from '@/pages/setup-page';
import { CreateOrgPage } from '@/pages/admin/create-org-page';
import { InvitePage } from '@/pages/invite-page';
import { ClusterPage } from '@/pages/cluster-page';
import { ClustersPage } from '@/pages/clusters-page';
import { TokensPage } from '@/pages/tokens-page';
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

export const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite',
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search.token === 'string' ? { token: search.token } : {},
  component: function Invite() {
    const { token } = inviteRoute.useSearch();
    return <InvitePage token={token} />;
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

function memberRoute(
  path: string,
  render: (orgId: string) => React.ReactNode,
): ReturnType<typeof createRoute> {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => (
      <RequireSession>
        <RequireOrg>{render}</RequireOrg>
      </RequireSession>
    ),
  }) as unknown as ReturnType<typeof createRoute>;
}

export const tokensRoute = memberRoute('/tokens', (id) => <TokensPage orgId={id} />);
export const clustersRoute = memberRoute('/clusters', (id) => <ClustersPage orgId={id} />);

export const clusterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clusters/$clusterId',
  component: function Cluster() {
    const { clusterId } = clusterRoute.useParams();
    return (
      <RequireSession>
        <RequireOrg>{(orgId) => <ClusterPage orgId={orgId} clusterId={clusterId} />}</RequireOrg>
      </RequireSession>
    );
  },
});

export const createOrgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/orgs/new',
  component: () => (
    <RequireSession>
      <CreateOrgPage />
    </RequireSession>
  ),
});

export const membersRoute = adminRoute('/admin/members', (id) => <MembersPage orgId={id} />);
export const teamsRoute = adminRoute('/admin/teams', (id) => <TeamsPage orgId={id} />);
export const ssoRoute = adminRoute('/admin/sso', (id) => <SsoPage orgId={id} />);
export const securityRoute = adminRoute('/admin/security', (id) => <SecurityPage orgId={id} />);
export const auditRoute = adminRoute('/admin/audit', (id) => <AuditPage orgId={id} />);
