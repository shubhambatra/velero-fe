import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { useAccess } from '@/lib/access';
import { useApprovalPolicy, type ApprovalPolicy } from '@/lib/approvals';
import { api, errorMessage } from '@/lib/client';

/**
 * Whether restores on this cluster need another person's approval (PLAN.md §8.4). The
 * organization's own setting is a floor that a cluster cannot go below, so when it is on the
 * box is ticked and cannot be cleared here.
 */
export function RestoreApprovalCard({
  orgId,
  clusterId,
}: {
  orgId: string;
  clusterId: string;
}): ReactElement {
  const client = useQueryClient();
  const policy = useApprovalPolicy(orgId, clusterId);
  const access = useAccess(orgId, clusterId);
  const set = useMutation({
    mutationFn: (required: boolean) =>
      api<ApprovalPolicy>(`/orgs/${orgId}/clusters/${clusterId}/restore-approval`, {
        method: 'PUT',
        body: { required },
      }),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ['org', orgId, 'cluster', clusterId, 'restore-approval'],
      }),
  });
  const p = policy.data;
  const mayManage = access.level('cluster:manage') !== 'none';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Restore approval</CardTitle>
        <CardDescription>
          When on, a restore on this cluster waits until another person who may restore the same
          namespaces approves it. Nothing is sent to the agent before that.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            disabled={p === undefined || p.fromOrg || !mayManage || set.isPending}
            checked={p?.required === true}
            onChange={(e) => {
              set.mutate(e.target.checked);
            }}
          />
          <span>Require approval of restores on this cluster</span>
        </label>
        {p?.fromOrg === true && (
          <p className="text-muted-foreground">Required by the organization.</p>
        )}
        {!mayManage && p?.fromOrg !== true && (
          <p className="text-muted-foreground">
            You need the cluster:manage permission on this cluster to change this.
          </p>
        )}
        <ErrorNote message={policy.isError ? errorMessage(policy.error) : undefined} />
        <ErrorNote message={set.isError ? errorMessage(set.error) : undefined} />
      </CardContent>
    </Card>
  );
}
