# REST API reference

_Generated from `server/openapi.yaml` by `pnpm --filter @vfm/server run gen:docs`. Do not edit by hand: a test fails when it drifts._

All paths are under `/api/v1`. 133 operations. Authentication is a session cookie (browser) or a `Bearer vfm_...`
API token; every state-changing request also needs the `X-CSRF-Token` header (sessions) and a recent
re-authentication ("sudo") where the operation is marked as needing one. Errors are RFC 9457
`application/problem+json`. Lists use cursor pagination (`limit` up to 200, `cursor`). The machine-readable
contract is `server/openapi.yaml` (OpenAPI 3.1).

## alerts

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/alerts/rules` | List alert rules, with how many of each are firing (Owner/Admin) | 200 |
| POST | `/orgs/{orgId}/alerts/rules` | Create an alert rule (Owner/Admin) | 201 |
| PATCH | `/orgs/{orgId}/alerts/rules/{ruleId}` | Change an alert rule (Owner/Admin) | 200 |
| DELETE | `/orgs/{orgId}/alerts/rules/{ruleId}` | Delete an alert rule and its history (Owner/Admin, sudo required) | 204 |
| GET | `/orgs/{orgId}/alerts/events` | Alert history, newest first (Owner/Admin) | 200 |
| GET | `/orgs/{orgId}/channels` | List notification channels (Owner/Admin) | 200 |
| POST | `/orgs/{orgId}/channels` | Create a channel (Owner/Admin); a webhook’s signing secret is returned once | 201 |
| PATCH | `/orgs/{orgId}/channels/{channelId}` | Change a channel, or make a webhook a new secret (Owner/Admin) | 200 |
| DELETE | `/orgs/{orgId}/channels/{channelId}` | Delete a channel and remove it from rules (Owner/Admin, sudo required) | 204 |
| POST | `/orgs/{orgId}/channels/{channelId}/test` | Send a test message through a channel (Owner/Admin); one attempt | 200 |

## approvals

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/approvals` | Restore requests waiting for approval, or decided in the last 30 days | 200 |
| GET | `/orgs/{orgId}/approvals/count` | How many waiting requests the caller may decide | 200 |
| POST | `/orgs/{orgId}/approvals/{commandId}/approve` | Approve a restore request (someone other than its requester; sudo required) | 200 |
| POST | `/orgs/{orgId}/approvals/{commandId}/reject` | Reject a restore request (someone other than its requester) | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/restore-approval` | Whether restores on this cluster need approval, and why | 200 |
| PUT | `/orgs/{orgId}/clusters/{clusterId}/restore-approval` | Ask for approval of restores on this cluster, or stop asking (sudo) | 200 |

## audit

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/audit` | Audit log, newest first (Owner/Admin) | 200 |
| GET | `/orgs/{orgId}/audit/export` | Audit log as CSV (Owner/Admin); the export is itself audited | 200 |

## auth

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/auth/setup` | Whether first-time setup is still available | 200 |
| POST | `/auth/setup` | Create the first platform administrator | 201, 401, 422 |
| POST | `/auth/login` | Sign in with email and password | 200, 401, 429 |
| POST | `/auth/sudo` | Re-authenticate to open the sudo window | 200, 401 |
| POST | `/auth/logout` | Sign out of the current session | 204 |
| DELETE | `/auth/sessions` | Sign out everywhere | 200 |
| GET | `/auth/me` | The currently authenticated user | 200 |
| GET | `/auth/mfa` | Multi-factor authentication status for the current user | 200 |
| DELETE | `/auth/mfa` | Disable multi-factor authentication | 204, 401, 403 |
| POST | `/auth/mfa/enrol` | Begin TOTP enrolment | 200 |
| POST | `/auth/mfa/enrol/confirm` | Confirm TOTP enrolment and receive recovery codes | 200, 401 |
| POST | `/auth/mfa/challenge` | Answer the second-factor challenge for the current session | 200, 401 |
| POST | `/auth/mfa/recovery-codes` | Replace the recovery codes | 200 |
| GET | `/auth/oidc/providers` | SSO buttons for an org’s sign-in page | 200 |
| GET | `/auth/oidc/{providerId}/start` | Begin SSO: redirects to the identity provider | 200 |
| GET | `/auth/oidc/callback` | SSO callback | 200 |

## backups

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| POST | `/orgs/{orgId}/clusters/{clusterId}/backups` | Create a backup (velero backup create) | 202 |
| DELETE | `/orgs/{orgId}/clusters/{clusterId}/backups/{name}` | Delete a backup and its data (velero backup delete) | 202 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/schedules/{name}/trigger` | Run a schedule now (velero backup create --from-schedule) | 202 |

## clusters

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/clusters` | List the clusters you can see | 200 |
| POST | `/orgs/{orgId}/clusters` | Add a cluster (Owner/Admin, sudo) | 201 |
| GET | `/orgs/{orgId}/clusters/{clusterId}` | Get one cluster | 200 |
| PATCH | `/orgs/{orgId}/clusters/{clusterId}` | Rename a cluster or change its labels | 200 |
| DELETE | `/orgs/{orgId}/clusters/{clusterId}` | Delete a cluster and lock its agent out (sudo) | 204 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/disable` | Disable a cluster: revoke its certificates (sudo) | 200 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/enable` | Re-enable a disabled cluster and issue a new token (sudo) | 200 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/bootstrap-token` | Issue a new bootstrap token (sudo) | 200 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/rotate-certificate` | Revoke the agent’s certificates and require it to enrol again (sudo) | 200 |

## commands

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| POST | `/orgs/{orgId}/clusters/{clusterId}/refresh-status` | Ask the agent to re-read Velero’s version and plugins | 202 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/commands` | The most recent commands for this cluster | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/commands/{commandId}` | One command and its outcome | 200 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/commands/{commandId}/cancel` | Cancel a command the agent has not started | 200 |

## downloads

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/clusters/{clusterId}/backups/{name}/logs` | A backup’s log, as text; 204 when none is held | 200 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/backups/{name}/logs` | Fetch a backup’s log from the cluster (or report a fresh copy) | 201 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/backups/{name}/details/{part}` | A detail file of a backup; 204 when none is held | 200 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/backups/{name}/details/{part}` | Fetch a detail file of a backup (results, resource-list, ...) | 201 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/restores/{name}/logs` | A restore’s log, as text; 204 when none is held | 200 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/restores/{name}/logs` | Fetch a restore’s log from the cluster (or report a fresh copy) | 201 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/restores/{name}/details/{part}` | A detail file of a restore; 204 when none is held | 200 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/restores/{name}/details/{part}` | Fetch a detail file of a restore (results, resource-list, ...) | 201 |

## health

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/healthz` | Liveness probe | 200 |
| GET | `/readyz` | Readiness probe | 200, 503 |

## inventory

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/clusters/{clusterId}/inventory` | Counts of Velero objects by kind and phase, for the kinds you may read | 200 |
| GET | `/orgs/{orgId}/fleet` | Every cluster you can see, with backup, schedule and storage health | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/overview` | Health, versions, policy, storage locations and recent activity of one cluster | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/backups` | Backups you may see | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/restores` | Restores you may see | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/schedules` | Schedules you may see | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/backup-locations` | Backup storage locations | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/snapshot-locations` | Volume snapshot locations | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/repositories` | Backup repositories | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/backups/{name}` | One backup: summary, timeline, spec, status, YAML and its volumes. 404 if you may not see it. | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/restores/{name}` | One restore: summary, timeline, spec, status and YAML. 404 if you may not see it. | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/schedules/{name}` | One schedule: summary, spec, status and YAML. 404 if you may not see it. | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/backup-locations/{name}` | One backup storage location: summary, spec, status and YAML | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/snapshot-locations/{name}` | One volume snapshot location: summary, spec, status and YAML | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/inventory/nodes` | Nodes of the cluster | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/inventory/namespaces` | Namespaces you may see | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/inventory/pods` | Pod summaries in the namespaces you may see (no env vars, specs or annotations) | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/inventory/pvcs` | Persistent volume claims in the namespaces you may see | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/inventory/events` | Warnings and Velero events of the last hour in the namespaces you may see | 200 |

## invites

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/invites` | Pending invitations (Owner/Admin) | 200 |
| POST | `/orgs/{orgId}/invites` | Invite someone by email (Owner/Admin) | 201 |
| DELETE | `/orgs/{orgId}/invites/{inviteId}` | Revoke an invitation (Owner/Admin, sudo required) | 204 |
| POST | `/invites/accept` | Accept an invitation with an existing account | 201 |
| POST | `/invites/register` | Accept an invitation by creating an account | 201 |

## logs

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| POST | `/orgs/{orgId}/clusters/{clusterId}/log-sessions` | Start a live log session for one container | 201 |
| DELETE | `/orgs/{orgId}/clusters/{clusterId}/log-sessions/{sessionId}` | Stop a live log session | 204 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/log-sessions/{sessionId}/stream` | Server-sent events for a log session: `chunk` events, then one `ended` | 200 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/log-shortcuts` | The Velero server and node-agent pods, for one-click log views | 200 |

## oidc

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/oidc-providers` | List OIDC providers (Owner/Admin). The secret is never returned. | 200 |
| POST | `/orgs/{orgId}/oidc-providers` | Add an OIDC provider (Owner/Admin) | 201 |
| PATCH | `/orgs/{orgId}/oidc-providers/{providerId}` | Update an OIDC provider (Owner/Admin) | 200 |
| DELETE | `/orgs/{orgId}/oidc-providers/{providerId}` | Remove an OIDC provider (Owner/Admin, sudo required) | 204 |

## orgs

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/me/orgs` | Organizations the caller belongs to (org switcher) | 200 |
| POST | `/me/active-org` | Switch the active organization | 204 |
| POST | `/orgs` | Create an organization | 201 |
| GET | `/orgs/{orgId}` | Organization details and settings | 200 |
| PATCH | `/orgs/{orgId}` | Update the name or MFA policy (Owner/Admin) | 200 |
| GET | `/orgs/{orgId}/members` | Members of the organization | 200 |
| PATCH | `/orgs/{orgId}/members/{userId}` | Change a member’s org role (Owner/Admin) | 204 |
| DELETE | `/orgs/{orgId}/members/{userId}` | Remove a member, or leave (sudo required) | 204 |

## rbac

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/clusters/{clusterId}/my-access` | What the caller may do on this cluster | 200 |
| GET | `/clusters/{clusterId}/role-bindings` | List role bindings (cluster:manage) | 200 |
| POST | `/clusters/{clusterId}/role-bindings` | Grant a role (cluster:manage, sudo) | 201 |
| DELETE | `/clusters/{clusterId}/role-bindings/{bindingId}` | Revoke a role binding (cluster:manage, sudo) | 204 |
| GET | `/orgs/{orgId}/clusters/{clusterId}/access` | What the caller may do on this cluster | 200 |

## reports

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/reports/success-rate` | Backups that finished, by outcome, per day or week and cluster, with the success rate | 200 |
| GET | `/orgs/{orgId}/reports/coverage` | Namespaces with no successful backup in the last N hours, or ever | 200 |
| GET | `/orgs/{orgId}/reports/rpo` | Per schedule: the share of the time the newest successful backup was within the objective | 200 |

## restores

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| POST | `/orgs/{orgId}/clusters/{clusterId}/restores` | Restore from a backup or a schedule (velero restore create) | 202 |
| DELETE | `/orgs/{orgId}/clusters/{clusterId}/restores/{name}` | Delete a restore (velero restore delete) | 202 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/restores/impact` | Which of these namespaces exist now (the restore wizard’s impact summary) | 202 |

## schedules

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| POST | `/orgs/{orgId}/clusters/{clusterId}/schedules` | Create a schedule (velero schedule create) | 202 |
| PUT | `/orgs/{orgId}/clusters/{clusterId}/schedules/{name}` | Replace a schedule’s spec | 202 |
| DELETE | `/orgs/{orgId}/clusters/{clusterId}/schedules/{name}` | Delete a schedule (velero schedule delete) | 202 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/schedules/{name}/pause` | Pause or resume a schedule (velero schedule pause / unpause) | 202 |

## storage

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| POST | `/orgs/{orgId}/clusters/{clusterId}/backup-locations` | Create a backup storage location (velero backup-location create) | 202 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/snapshot-locations` | Create a volume snapshot location (velero snapshot-location create) | 202 |
| PUT | `/orgs/{orgId}/clusters/{clusterId}/backup-locations/{name}` | Replace a backup storage location’s spec | 202 |
| DELETE | `/orgs/{orgId}/clusters/{clusterId}/backup-locations/{name}` | Delete a backup storage location (velero backup-location delete) | 202 |
| PUT | `/orgs/{orgId}/clusters/{clusterId}/snapshot-locations/{name}` | Replace a volume snapshot location’s spec | 202 |
| DELETE | `/orgs/{orgId}/clusters/{clusterId}/snapshot-locations/{name}` | Delete a volume snapshot location (velero snapshot-location delete) | 202 |
| POST | `/orgs/{orgId}/clusters/{clusterId}/backup-locations/{name}/default` | Make a backup storage location the default (velero backup-location set --default) | 202 |

## stream

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/stream` | Server-sent events: cluster status, inventory changes and command progress | 200 |

## teams

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/teams` | List teams | 200 |
| POST | `/orgs/{orgId}/teams` | Create a team (Owner/Admin) | 201 |
| PATCH | `/orgs/{orgId}/teams/{teamId}` | Rename or describe a team (Owner/Admin) | 204 |
| DELETE | `/orgs/{orgId}/teams/{teamId}` | Delete a team (Owner/Admin, sudo required) | 204 |
| GET | `/orgs/{orgId}/teams/{teamId}/members` | Members of a team | 200 |
| PUT | `/orgs/{orgId}/teams/{teamId}/members/{userId}` | Add an org member to a team (Owner/Admin) | 204 |
| DELETE | `/orgs/{orgId}/teams/{teamId}/members/{userId}` | Remove a member from a team (Owner/Admin) | 204 |

## tokens

| Method | Path | What it does | Responses |
| --- | --- | --- | --- |
| GET | `/orgs/{orgId}/tokens` | List tokens: your own, or the whole org with ?scope=org (Owner/Admin) | 200 |
| POST | `/orgs/{orgId}/tokens` | Create a token (sudo) | 201 |
| DELETE | `/orgs/{orgId}/tokens/{tokenId}` | Revoke a token (own, or any as Owner/Admin) | 204 |
