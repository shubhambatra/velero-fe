# RBAC reference

_Generated from `packages/shared/src/rbac.ts` by `pnpm --filter @vfm/server run gen:docs`. Do not edit by hand: a test fails when it drifts._

## Roles and permissions (PLAN section 8.2)

| Permission | Scope | Viewer | Operator | Restorer | Cluster Admin |
| --- | --- | :---: | :---: | :---: | :---: |
| `cluster:read` | cluster | yes | yes | yes | yes |
| `backup:read` | namespace | yes | yes | yes | yes |
| `restore:read` | namespace | yes | yes | yes | yes |
| `schedule:read` | namespace | yes | yes | yes | yes |
| `storage:read` | cluster | yes | yes | yes | yes |
| `backup:logs` | namespace | - | yes | yes | yes |
| `restore:logs` | namespace | - | yes | yes | yes |
| `logs:read` | namespace | - | yes | yes | yes |
| `backup:create` | namespace | - | yes | yes | yes |
| `schedule:write` | namespace | - | yes | - | yes |
| `restore:create` | namespace | - | - | yes | yes |
| `backup:delete` | namespace | - | - | - | yes |
| `restore:delete` | namespace | - | - | - | yes |
| `schedule:delete` | namespace | - | - | - | yes |
| `storage:write` | cluster | - | - | - | yes |
| `backup:download` | namespace | - | - | - | yes |
| `advanced:write` | cluster | - | - | - | yes |
| `cluster:manage` | cluster | - | - | - | yes |

## How a decision is made

* **Deny by default, and on doubt.** A permission exists only where a binding positively grants it.
* A binding gives a **role** to a **user or a team** on **one cluster**, with a scope: the whole cluster,
  a list of namespaces, or a label selector (a selector denies until namespace labels are synced).
* **Namespaced permissions** (`namespace` above) are checked against every namespace a request touches.
  A request is allowed only if **all** of them are in scope: for a restore, both the source and the
  mapped target namespace. A request that includes cluster-scoped resources, or a wildcard, needs a
  whole-cluster binding.
* A namespace-scoped binding still carries `cluster:read` and `storage:read`, so the person can see the
  cluster exists and where it backs up to, and nothing about other namespaces.
* **Organization Owners and Admins** are implicitly Cluster Admin on every cluster of the organization.
  The **platform admin** administers organizations, not their clusters.
* A cluster you may not see is `404`; one you can see but may not act on is `403`.
* **Sudo mode**: restore create, any delete, storage writes, cluster deletion and role-binding changes also
  need a re-authentication within the last 5 minutes.
* **API tokens** can only narrow: a token holds a subset of its owner's permissions and clusters, never more.
* The cluster owner can narrow further with the **agent policy** (`readOnly`, denied namespaces, no
  BSL writes, no log streaming); the control plane cannot widen it.
