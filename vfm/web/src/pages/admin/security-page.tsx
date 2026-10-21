import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field } from '@/components/ui/field';
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
      auditRetentionDays?: number;
      auditExportBeforeDelete?: boolean;
    }) => api(`/orgs/${orgId}`, { method: 'PATCH', body: patch }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const settings = org.data?.settings;
  const [days, setDays] = useState('400');
  useEffect(() => {
    if (settings?.auditRetentionDays !== undefined) {
      setDays(String(settings.auditRetentionDays));
    }
  }, [settings?.auditRetentionDays]);
  const parsedDays = Number(days);
  const daysOk = Number.isInteger(parsedDays) && parsedDays >= 30 && parsedDays <= 3650;

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

      <Card>
        <CardHeader>
          <CardTitle>Audit log retention</CardTitle>
          <CardDescription>
            Audit events older than this are deleted once a day. The default is 400 days; the
            shortest is 30.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (daysOk) {
                update.mutate({ auditRetentionDays: parsedDays });
              }
            }}
          >
            <Field
              label="Keep audit events for (days)"
              type="number"
              min={30}
              max={3650}
              value={days}
              disabled={settings === undefined}
              onChange={(e) => {
                setDays(e.target.value);
              }}
              hint={daysOk ? undefined : 'Between 30 and 3650 days.'}
            />
            <Button
              type="submit"
              disabled={
                settings === undefined ||
                update.isPending ||
                !daysOk ||
                parsedDays === (settings.auditRetentionDays ?? 400)
              }
            >
              Save
            </Button>
          </form>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              disabled={settings === undefined || update.isPending}
              checked={settings?.auditExportBeforeDelete === true}
              onChange={(e) => {
                update.mutate({ auditExportBeforeDelete: e.target.checked });
              }}
            />
            <span>
              Write events to a file before deleting them
              <span className="block text-sm text-muted-foreground">
                The operator provides the directory. If there is none, nothing is deleted for this
                organization rather than deleted unexported.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>
    </div>
  );
}
