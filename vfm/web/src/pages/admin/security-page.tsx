import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import type { OrgDetail } from '@/lib/types';

export function SecurityPage({ orgId }: { orgId: string }): ReactElement {
  const client = useQueryClient();
  const key = ['org', orgId, 'detail'];
  const org = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<OrgDetail>(`/orgs/${orgId}`, { signal }),
  });
  const update = useMutation({
    mutationFn: (patch: {
      mfaRequired?: boolean;
      allowBackupContentDownload?: boolean;
      requireRestoreApproval?: boolean;
    }) => api(`/orgs/${orgId}`, { method: 'PATCH', body: patch }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const settings = org.data?.settings;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Security settings</h1>
      <ErrorNote message={org.isError ? errorMessage(org.error) : undefined} />
      <ErrorNote message={update.isError ? errorMessage(update.error) : undefined} />
      <Card>
        <CardHeader>
          <CardTitle>Organization policy</CardTitle>
          <CardDescription>
            Applies to everyone in {org.data?.name ?? 'this organization'}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              disabled={settings === undefined || update.isPending}
              checked={settings?.mfaRequired === true}
              onChange={(e) => {
                update.mutate({ mfaRequired: e.target.checked });
              }}
            />
            <span>Require two-step verification for every member</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              disabled={settings === undefined || update.isPending}
              checked={settings?.allowBackupContentDownload === true}
              onChange={(e) => {
                update.mutate({ allowBackupContentDownload: e.target.checked });
              }}
            />
            <span>Allow downloading backup contents</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              disabled={settings === undefined || update.isPending}
              checked={settings?.requireRestoreApproval === true}
              onChange={(e) => {
                update.mutate({ requireRestoreApproval: e.target.checked });
              }}
            />
            <span>
              Require approval of restores
              <span className="block text-sm text-muted-foreground">
                Another person who may restore the same namespaces must approve each restore before
                it is sent. Applies to every cluster; a cluster cannot opt out.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>
    </div>
  );
}
