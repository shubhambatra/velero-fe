import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLUSTER_ROLES, CLUSTER_ROLE_LABELS, BUILT_IN_ROLES } from '@vfm/shared';
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field, inputClass } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import type { Member, Team } from '@/lib/types';

interface Binding {
  id: string;
  subjectType: 'USER' | 'TEAM';
  subjectId: string;
  subjectName: string | null;
  role: string;
  scope: { type: 'CLUSTER' } | { type: 'NAMESPACES'; namespaces: string[] } | { type: 'SELECTOR' };
  createdAt: string;
}

const ROLE_LABEL: Record<string, string> = CLUSTER_ROLE_LABELS;

const scopeText = (s: Binding['scope']): string =>
  s.type === 'CLUSTER'
    ? 'whole cluster'
    : s.type === 'NAMESPACES'
      ? `namespaces: ${s.namespaces.join(', ')}`
      : 'namespaces matching a label selector';

/**
 * Who may do what on this cluster (PLAN.md section 8.2, 11.1 page 3 "Access"). Granting and revoking need
 * `cluster:manage` and a recent re-authentication; the request that follows opens the sudo
 * dialog by itself when the server asks for it.
 */
export function ClusterAccessPage({
  orgId,
  clusterId,
}: {
  orgId: string;
  clusterId: string;
}): ReactElement {
  const client = useQueryClient();
  const key = ['org', orgId, 'cluster', clusterId, 'bindings'];
  const [subject, setSubject] = useState('');
  const [role, setRole] = useState('VIEWER');
  const [scope, setScope] = useState<'CLUSTER' | 'NAMESPACES'>('CLUSTER');
  const [namespaces, setNamespaces] = useState('');

  const bindings = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<{ bindings: Binding[] }>(`/clusters/${clusterId}/role-bindings`, { signal }),
  });
  const members = useQuery({
    queryKey: ['org', orgId, 'members'],
    queryFn: ({ signal }) => api<{ members: Member[] }>(`/orgs/${orgId}/members`, { signal }),
  });
  const teams = useQuery({
    queryKey: ['org', orgId, 'teams'],
    queryFn: ({ signal }) => api<{ teams: Team[] }>(`/orgs/${orgId}/teams`, { signal }),
  });

  const grant = useMutation({
    mutationFn: () => {
      const [subjectType, subjectId] = subject.split(':') as ['USER' | 'TEAM', string];
      return api(`/clusters/${clusterId}/role-bindings`, {
        method: 'POST',
        body: {
          subjectType,
          subjectId,
          role,
          scope:
            scope === 'CLUSTER'
              ? { type: 'CLUSTER' }
              : {
                  type: 'NAMESPACES',
                  namespaces: namespaces
                    .split(/[\s,]+/)
                    .map((n) => n.trim())
                    .filter((n) => n !== ''),
                },
        },
      });
    },
    onSuccess: async () => {
      setSubject('');
      setNamespaces('');
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/clusters/${clusterId}/role-bindings/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    grant.mutate();
  };
  const rows = bindings.data?.bindings ?? [];

  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="access">
      <p className="text-sm text-muted-foreground">
        Organization Owners and Admins are Cluster Admin on every cluster and are not listed here.
        Everyone else needs a role on this cluster, directly or through a team.
      </p>
      <ErrorNote
        message={
          bindings.isError
            ? errorMessage(bindings.error)
            : revoke.isError
              ? errorMessage(revoke.error)
              : undefined
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Role bindings</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {bindings.isSuccess && rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nobody has a role on this cluster yet. Grant one below.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="p-2">Who</th>
                  <th className="p-2">Role</th>
                  <th className="p-2">Where</th>
                  <th className="p-2">Since</th>
                  <th className="p-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} className="border-b border-border last:border-0">
                    <td className="p-2">
                      {b.subjectName ?? 'unknown (removed)'}{' '}
                      <Badge tone="neutral">{b.subjectType === 'TEAM' ? 'team' : 'user'}</Badge>
                    </td>
                    <td className="p-2">{ROLE_LABEL[b.role] ?? b.role}</td>
                    <td className="p-2">{scopeText(b.scope)}</td>
                    <td className="p-2">
                      <Time value={b.createdAt} />
                    </td>
                    <td className="p-2">
                      <Button
                        variant="outline"
                        disabled={revoke.isPending}
                        aria-label={`Revoke ${b.subjectName ?? 'binding'}`}
                        onClick={() => {
                          revoke.mutate(b.id);
                        }}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Grant a role</CardTitle>
          <CardDescription>
            A role over a list of namespaces gives access to those namespaces only, plus seeing that
            the cluster and its storage exist.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="grant-subject" className="text-sm font-medium">
                Person or team
              </label>
              <select
                id="grant-subject"
                className={inputClass}
                required
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                }}
              >
                <option value="">Choose…</option>
                <optgroup label="Teams">
                  {(teams.data?.teams ?? []).map((t) => (
                    <option key={t.id} value={`TEAM:${t.id}`}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="People">
                  {(members.data?.members ?? []).map((m) => (
                    <option key={m.userId} value={`USER:${m.userId}`}>
                      {m.email}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="grant-role" className="text-sm font-medium">
                Role
              </label>
              <select
                id="grant-role"
                className={inputClass}
                value={role}
                onChange={(e) => {
                  setRole(e.target.value);
                }}
              >
                {CLUSTER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]} ({BUILT_IN_ROLES[r].length} permissions)
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="grant-scope" className="text-sm font-medium">
                Applies to
              </label>
              <select
                id="grant-scope"
                className={inputClass}
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as 'CLUSTER' | 'NAMESPACES');
                }}
              >
                <option value="CLUSTER">The whole cluster</option>
                <option value="NAMESPACES">Only some namespaces</option>
              </select>
            </div>
            {scope === 'NAMESPACES' && (
              <Field
                label="Namespaces"
                required
                hint="Separated by commas or spaces."
                value={namespaces}
                onChange={(e) => {
                  setNamespaces(e.target.value);
                }}
              />
            )}
            <ErrorNote message={grant.isError ? errorMessage(grant.error) : undefined} />
            <div>
              <Button type="submit" variant="primary" disabled={grant.isPending || subject === ''}>
                Grant role
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </ClusterShell>
  );
}
