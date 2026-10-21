import { createRoute } from '@tanstack/react-router';

import { RequireAdmin, RequireOrg, RequireSession } from '@/components/require-session';
import { LoginPage } from '@/pages/login-page';
import { MfaPage } from '@/pages/mfa-page';
import { SetupPage } from '@/pages/setup-page';
import { CreateOrgPage } from '@/pages/admin/create-org-page';
import { InvitePage } from '@/pages/invite-page';
import { BackupDetailPage, RestoreDetailPage } from '@/pages/cluster-detail';
import { LocationFormPage } from '@/pages/location-form';
import { EventsPage, WorkloadsPage } from '@/pages/workloads';
import { ClusterActivityPage } from '@/pages/cluster-activity';
import { ClusterAccessPage } from '@/pages/cluster-access';
import { ClusterSettingsPage } from '@/pages/cluster-settings';
import { ScheduleWizardPage } from '@/pages/schedule-wizard';
import { BackupsPage, RestoresPage, SchedulesPage, StoragePage } from '@/pages/cluster-lists';
import { ClusterPage } from '@/pages/cluster-page';
import { ClustersPage } from '@/pages/clusters-page';
import { FleetBackupsPage, FleetRestoresPage, FleetSchedulesPage } from '@/pages/fleet-lists';
import { TokensPage } from '@/pages/tokens-page';
import { ApprovalsPage } from '@/pages/approvals-page';
import { ReportsPage } from '@/pages/reports-page';
import { AlertsPage } from '@/pages/admin/alerts-page';
import { AuditPage } from '@/pages/admin/audit-page';
import { MembersPage } from '@/pages/admin/members-page';
import { SecurityPage } from '@/pages/admin/security-page';
import { SsoPage } from '@/pages/admin/sso-page';
import { TeamsPage } from '@/pages/admin/teams-page';

import { BackupWizardPage } from '@/pages/backup-wizard';
import { RestoreWizardPage } from '@/pages/restore-wizard';
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

export const approvalsRoute = memberRoute('/approvals', (id) => <ApprovalsPage orgId={id} />);
export const reportsRoute = memberRoute('/reports', (id) => <ReportsPage orgId={id} />);
export const tokensRoute = memberRoute('/tokens', (id) => <TokensPage orgId={id} />);
export const clustersRoute = memberRoute('/clusters', (id) => <ClustersPage orgId={id} />);
export const fleetBackupsRoute = memberRoute('/fleet/backups', (id) => (
  <FleetBackupsPage orgId={id} />
));
export const fleetRestoresRoute = memberRoute('/fleet/restores', (id) => (
  <FleetRestoresPage orgId={id} />
));
export const fleetSchedulesRoute = memberRoute('/fleet/schedules', (id) => (
  <FleetSchedulesPage orgId={id} />
));

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
export const alertsRoute = adminRoute('/admin/alerts', (id) => <AlertsPage orgId={id} />);
export const auditRoute = adminRoute('/admin/audit', (id) => <AuditPage orgId={id} />);

/** A route under `/clusters/$clusterId/...` that needs the active org and the cluster id. */
function clusterSubRoute(
  path: string,
  render: (orgId: string, clusterId: string, name: string) => React.ReactNode,
) {
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: function ClusterSub() {
      const params: { clusterId: string; name?: string } = route.useParams();
      return (
        <RequireSession>
          <RequireOrg>{(orgId) => render(orgId, params.clusterId, params.name ?? '')}</RequireOrg>
        </RequireSession>
      );
    },
  });
  return route;
}

export const backupsRoute = clusterSubRoute('/clusters/$clusterId/backups', (o, c) => (
  <BackupsPage orgId={o} clusterId={c} />
));
export const restoresRoute = clusterSubRoute('/clusters/$clusterId/restores', (o, c) => (
  <RestoresPage orgId={o} clusterId={c} />
));
export const schedulesRoute = clusterSubRoute('/clusters/$clusterId/schedules', (o, c) => (
  <SchedulesPage orgId={o} clusterId={c} />
));
export const newScheduleRoute = clusterSubRoute('/clusters/$clusterId/schedules/new', (o, c) => (
  <ScheduleWizardPage orgId={o} clusterId={c} />
));
export const editScheduleRoute = clusterSubRoute(
  '/clusters/$clusterId/schedules/$name/edit',
  (o, c, n) => <ScheduleWizardPage orgId={o} clusterId={c} name={n} />,
);
export const storageRoute = clusterSubRoute('/clusters/$clusterId/storage', (o, c) => (
  <StoragePage orgId={o} clusterId={c} />
));
export const workloadsRoute = clusterSubRoute('/clusters/$clusterId/workloads', (o, c) => (
  <WorkloadsPage orgId={o} clusterId={c} />
));
export const activityRoute = clusterSubRoute('/clusters/$clusterId/activity', (o, c) => (
  <ClusterActivityPage orgId={o} clusterId={c} />
));
export const accessRoute = clusterSubRoute('/clusters/$clusterId/access', (o, c) => (
  <ClusterAccessPage orgId={o} clusterId={c} />
));
export const settingsRoute = clusterSubRoute('/clusters/$clusterId/settings', (o, c) => (
  <ClusterSettingsPage orgId={o} clusterId={c} />
));
export const eventsRoute = clusterSubRoute('/clusters/$clusterId/events', (o, c) => (
  <EventsPage orgId={o} clusterId={c} />
));
export const newBackupLocationRoute = clusterSubRoute(
  '/clusters/$clusterId/storage/backup-locations/new',
  (o, c) => <LocationFormPage orgId={o} clusterId={c} kind="backup" />,
);
export const editBackupLocationRoute = clusterSubRoute(
  '/clusters/$clusterId/storage/backup-locations/$name/edit',
  (o, c, n) => <LocationFormPage orgId={o} clusterId={c} kind="backup" name={n} />,
);
export const newSnapshotLocationRoute = clusterSubRoute(
  '/clusters/$clusterId/storage/snapshot-locations/new',
  (o, c) => <LocationFormPage orgId={o} clusterId={c} kind="snapshot" />,
);
export const editSnapshotLocationRoute = clusterSubRoute(
  '/clusters/$clusterId/storage/snapshot-locations/$name/edit',
  (o, c, n) => <LocationFormPage orgId={o} clusterId={c} kind="snapshot" name={n} />,
);
export const newBackupRoute = clusterSubRoute('/clusters/$clusterId/backups/new', (o, c) => (
  <BackupWizardPage orgId={o} clusterId={c} />
));
export const backupDetailRoute = clusterSubRoute(
  '/clusters/$clusterId/backups/$name',
  (o, c, n) => <BackupDetailPage orgId={o} clusterId={c} name={n} />,
);
export const newRestoreRoute = clusterSubRoute('/clusters/$clusterId/restores/new', (o, c) => (
  <RestoreWizardPage orgId={o} clusterId={c} />
));
export const restoreDetailRoute = clusterSubRoute(
  '/clusters/$clusterId/restores/$name',
  (o, c, n) => <RestoreDetailPage orgId={o} clusterId={c} name={n} />,
);
