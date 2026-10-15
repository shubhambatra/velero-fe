import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { inputClass } from '@/components/ui/field';
import { api } from '@/lib/client';
import { ORGS_KEY, SESSION_KEY, useOrgs } from '@/lib/session';

/** Header control: switch the active org (POST /me/active-org) and sign out. */
export function OrgSwitcher({ email }: { email: string }): ReactElement {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { orgs, active } = useOrgs(true);

  const switchOrg = useMutation({
    mutationFn: (orgId: string) => api('/me/active-org', { method: 'POST', body: { orgId } }),
    onSuccess: async () => {
      // Every cached admin query is keyed by org id, but the active flag and
      // the role both changed, so refetch the lot.
      await client.invalidateQueries();
    },
  });

  const signOut = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSettled: async () => {
      client.clear();
      client.removeQueries({ queryKey: SESSION_KEY });
      client.removeQueries({ queryKey: ORGS_KEY });
      await navigate({ to: '/login' });
    },
  });

  return (
    <div className="flex items-center gap-2">
      {orgs.length > 0 && (
        <>
          <label htmlFor="org-switcher" className="sr-only">
            Organization
          </label>
          <select
            id="org-switcher"
            className={`${inputClass} w-auto max-w-40`}
            value={active?.id ?? ''}
            onChange={(e) => {
              switchOrg.mutate(e.target.value);
            }}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </>
      )}
      <span className="hidden text-sm text-muted-foreground lg:inline">{email}</span>
      <Button
        onClick={() => {
          signOut.mutate();
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
