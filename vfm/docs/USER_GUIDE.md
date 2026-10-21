# User guide

For people who use Velero Fleet Manager (VFM) day to day. Operators install it with [`OPERATIONS.md`](./OPERATIONS.md); the
permission model is in [`RBAC.md`](./RBAC.md).

## Signing in

The first visitor of a new installation sees **Setup** and creates the platform administrator. Everyone else is invited by e-mail
(or by a link an Admin copies, when the installation has no mail server) or signs in through the organization's single sign-on.
Two-factor sign-in (TOTP) is required when the organization says so. Actions that delete or change credentials ask for your password
again ("sudo mode", a few minutes) and are refused to API tokens.

## Organizations, clusters, and who can do what

- An **organization** holds members, teams, clusters, alert rules, notification channels and an audit trail. Nothing crosses organizations.
- **Add cluster** (Fleet → Add cluster) gives a one-time bootstrap token and a ready-made `helm install` command for the agent chart.
  The agent dials out to VFM; nothing needs to reach into your cluster. The cluster is _Connected_ within seconds; the token is spent.
- A **role binding** gives a user or team a role on one cluster, for the whole cluster or only for named namespaces:
  Viewer (read only), Operator (also read logs, create backups, manage schedules), Restorer (read logs, create backups and restores; no schedule changes),
  Cluster Admin (everything, including deleting backups, storage, downloads and advanced settings). The full table is in `RBAC.md`.
  A button you may not use is disabled and says why. The cluster's **Access** tab shows what each person can do and lets you ask for more.
- The installer can also put the cluster in **read-only** mode (agent policy `readOnly`): every change is refused by the agent itself.

## Working with many clusters

- **Cluster switcher** (header, from two clusters up): jump straight to any cluster, or back to _All clusters_. It follows the page you are on.
- **Fleet overview** (home): a _Health_ map with one tile per cluster, most urgent first (critical: latest backup failed or storage unavailable;
  warning: agent disconnected, invalid schedule or partially failed backup; offline: not enrolled or disabled), the fleet totals, what needs attention, and the
  cluster table. Filter the table by name, status or a **group**: a group is a cluster label such as `env=prod` (set labels in _Cluster → Settings_).
  Totals and the attention list always cover the whole fleet.
- **All backups / All restores / All schedules** (left menu): one list across every cluster you can read, newest first, with a cluster column, the same
  filters and a phase filter. Each cluster is read with your own permissions, so a cluster you may not read is named under the list and none of its data is shown.
  Each cluster contributes its latest 50 rows, and at most 25 clusters are read at a time; narrow with the filters to see others.

## Backups

Cluster → **Backups** → _Create_. Choose namespaces (or all, which needs a binding over all), what to do about volumes, a TTL and
the storage location. The panel shows the equivalent `velero backup create …` line. The result of the _command_ is shown apart from
the result of the _backup_: a command can succeed and the backup still fail.
Open a backup for its logs, resource list, volumes (including file-system backup and snapshot details) and results. Deleting a backup (one or several rows) needs Cluster Admin, a typed confirmation and sudo.

**Download.** If your organization has turned on _allow backup content download_ and you are a Cluster Admin over every namespace in the backup, _Download_ gives a
link that expires within minutes and points straight at the object storage. VFM never carries the data and never stores the link.

## Restores

_Restore_ on a backup opens the wizard: pick what to restore, map namespaces (`demo → demo-restored`), and whether to include cluster-scoped resources
(CRDs, ClusterRoleBindings, volumes). Where the cluster forbids that (agent policy), the option is off and says why. If your organization requires approval, the restore is
held until someone else with the right approves it. Restoring needs a typed confirmation and sudo.

## Schedules

Cluster → **Schedules**: create from a cron expression, _run now_, _pause_, _resume_. A paused schedule makes no backups until resumed.

## Storage

Cluster → **Storage** manages backup storage locations and snapshot locations. Credentials are write-only: you can set them and VFM sends them to the agent,
but they are never shown again, never logged and never stored in plain text.

## Alerts and notifications

Organization → **Alerts**: rules for a failed backup, a missed schedule, a disconnected agent, an unavailable storage location, or a backup about to expire. Fired alerts go to channels (e-mail,
signed webhook, Slack webhook) and resolve by themselves. A cluster's **Activity** tab and the organization **Audit** page list who did what, with CSV export.

## Reports

**Reports**: backup success rate, last-good-backup age (RPO) per cluster and namespace, and which namespaces have no recent backup. A report is a shared summary up to 30 s old.

## Settings (Owner/Admin)

Organization **Security** page: require two-factor sign-in, require restore approval, allow backup content download (off by default), audit retention days and
whether to export audit events to a file before they are deleted.
