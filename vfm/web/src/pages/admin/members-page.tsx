import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field, inputClass } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import type { Invite, Member, OrgRole } from '@/lib/types';

const ROLES: OrgRole[] = ['OWNER', 'ADMIN', 'MEMBER'];

export function MembersPage({ orgId }: { orgId: string }): ReactElement {
  const client = useQueryClient();
  const membersKey = ['org', orgId, 'members'];
  const invitesKey = ['org', orgId, 'invites'];
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('MEMBER');

  const members = useQuery({
    queryKey: membersKey,
    queryFn: ({ signal }) => api<{ members: Member[] }>(`/orgs/${orgId}/members`, { signal }),
  });
  const invites = useQuery({
    queryKey: invitesKey,
    queryFn: ({ signal }) => api<{ invites: Invite[] }>(`/orgs/${orgId}/invites`, { signal }),
  });

  const changeRole = useMutation({
    mutationFn: (v: { userId: string; orgRole: OrgRole }) =>
      api(`/orgs/${orgId}/members/${v.userId}`, { method: 'PATCH', body: { orgRole: v.orgRole } }),
    onSettled: () => client.invalidateQueries({ queryKey: membersKey }),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api(`/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    onSettled: () => client.invalidateQueries({ queryKey: membersKey }),
  });
  const invite = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/invites`, { method: 'POST', body: { email, orgRole: inviteRole } }),
    onSuccess: async () => {
      setEmail('');
      await client.invalidateQueries({ queryKey: invitesKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/orgs/${orgId}/invites/${id}`, { method: 'DELETE' }),
    onSettled: () => client.invalidateQueries({ queryKey: invitesKey }),
  });

  const actionError = [changeRole, remove, revoke].find((m) => m.isError)?.error;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Members</h1>
      <ErrorNote message={actionError === undefined ? undefined : errorMessage(actionError)} />

      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <ErrorNote message={members.isError ? errorMessage(members.error) : undefined} />
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="py-1 pr-3">Email</th>
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Role</th>
                <th className="py-1 pr-3">MFA</th>
                <th className="py-1">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.data?.members.map((m) => (
                <tr key={m.userId} className="border-t border-border">
                  <td className="py-1 pr-3">{m.email}</td>
                  <td className="py-1 pr-3">{m.name ?? ''}</td>
                  <td className="py-1 pr-3">
                    <select
                      aria-label={`Role for ${m.email}`}
                      className={inputClass}
                      value={m.orgRole}
                      onChange={(e) => {
                        changeRole.mutate({ userId: m.userId, orgRole: e.target.value as OrgRole });
                      }}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1 pr-3">{m.mfaEnabled ? 'On' : 'Off'}</td>
                  <td className="py-1">
                    <Button
                      aria-label={`Remove ${m.email}`}
                      onClick={() => {
                        remove.mutate(m.userId);
                      }}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invite by email</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate();
            }}
          >
            <div className="min-w-60 flex-1">
              <Field
                label="Email"
                type="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="invite-role" className="text-sm font-medium">
                Role
              </label>
              <select
                id="invite-role"
                className={inputClass}
                value={inviteRole}
                onChange={(e) => {
                  setInviteRole(e.target.value as OrgRole);
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="primary" disabled={invite.isPending}>
              Send invite
            </Button>
          </form>
          <ErrorNote message={invite.isError ? errorMessage(invite.error) : undefined} />

          {invites.data !== undefined && invites.data.invites.length > 0 && (
            <ul className="flex flex-col gap-2">
              {invites.data.invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3">
                  <span>
                    {i.email} ({i.orgRole}), expires {new Date(i.expiresAt).toLocaleDateString()}
                  </span>
                  <Button
                    aria-label={`Revoke invite for ${i.email}`}
                    onClick={() => {
                      revoke.mutate(i.id);
                    }}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
