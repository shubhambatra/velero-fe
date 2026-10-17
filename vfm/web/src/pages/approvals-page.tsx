import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, inputClass } from '@/components/ui/field';
import { namespaceText, outcome, who, type ApprovalItem } from '@/lib/approvals';
import { api, errorMessage } from '@/lib/client';

const TABS = [
  { id: 'pending', label: 'Waiting' },
  { id: 'decided', label: 'Decided' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/**
 * Restore requests that need a second person (PLAN.md §8.4): the ones waiting, with the means
 * to decide them where the caller may, and what became of the rest. The server decides who
 * may approve; this only shows the buttons it says apply.
 */
export function ApprovalsPage({ orgId }: { orgId: string }): ReactElement {
  const [tab, setTab] = useState<Tab>('pending');
  const client = useQueryClient();
  const key = ['org', orgId, 'approvals', tab];
  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<{ approvals: ApprovalItem[] }>(`/orgs/${orgId}/approvals?status=${tab}`, { signal }),
  });
  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['org', orgId, 'approvals'] });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Restore approvals</h1>
      <div role="group" aria-label="Show" className="flex gap-1">
        {TABS.map((t) => (
          <Button
            key={t.id}
            variant={tab === t.id ? 'primary' : 'outline'}
            aria-pressed={tab === t.id}
            onClick={() => {
              setTab(t.id);
            }}
          >
            {t.label}
          </Button>
        ))}
      </div>
      <ErrorNote message={list.isError ? errorMessage(list.error) : undefined} />
      {list.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {list.data?.approvals.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {tab === 'pending'
            ? 'Nothing is waiting for approval.'
            : 'Nothing has been decided in the last 30 days.'}
        </p>
      )}
      {list.data?.approvals.map((item) => (
        <Request
          key={item.id}
          orgId={orgId}
          item={item}
          decided={tab === 'decided'}
          onChanged={refresh}
        />
      ))}
    </div>
  );
}

function Request({
  orgId,
  item,
  decided,
  onChanged,
}: {
  orgId: string;
  item: ApprovalItem;
  decided: boolean;
  onChanged: () => Promise<void>;
}): ReactElement {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const s = item.summary;

  const approve = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/approvals/${item.id}/approve`, { method: 'POST', body: {} }),
    onSuccess: onChanged,
  });
  const reject = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/approvals/${item.id}/reject`, {
        method: 'POST',
        body: note.trim() === '' ? {} : { note: note.trim() },
      }),
    onSuccess: onChanged,
  });
  const withdraw = useMutation({
    mutationFn: () =>
      api(`/orgs/${orgId}/clusters/${item.clusterId}/commands/${item.id}/cancel`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: onChanged,
  });
  const failure = [approve, reject, withdraw].find((m) => m.isError)?.error;
  const busy = approve.isPending || reject.isPending || withdraw.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span>{`Restore on ${item.clusterName}`}</span>
          {decided && (
            <Badge
              tone={item.status === 'REJECTED' || item.status === 'TIMED_OUT' ? 'error' : 'neutral'}
            >
              {item.status === 'REJECTED'
                ? 'Rejected'
                : item.approvedBy !== null
                  ? 'Approved'
                  : 'Expired'}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Asked by</dt>
          <dd>
            {who(item.requestedBy)}
            {item.isMine ? ' (you)' : ''}
          </dd>
          <dt className="text-muted-foreground">From</dt>
          <dd className="font-mono">
            {s.backupName !== null
              ? `backup ${s.backupName}`
              : s.scheduleName !== null
                ? `latest backup of schedule ${s.scheduleName}`
                : 'unknown'}
          </dd>
          <dt className="text-muted-foreground">Namespaces</dt>
          <dd className="font-mono break-words">
            {namespaceText(s.namespaces, s.namespaceMapping)}
          </dd>
          <dt className="text-muted-foreground">Cluster resources</dt>
          <dd>{s.includesClusterResources ? 'included' : 'not included'}</dd>
          <dt className="text-muted-foreground">If something exists</dt>
          <dd>{s.existingResourcePolicy === 'update' ? 'update it' : 'leave it (default)'}</dd>
          <dt className="text-muted-foreground">Asked</dt>
          <dd>
            <Time value={item.createdAt} />
          </dd>
          {!decided && (
            <>
              <dt className="text-muted-foreground">Expires</dt>
              <dd>
                <Time value={item.expiresAt} />
              </dd>
            </>
          )}
          {decided && (
            <>
              <dt className="text-muted-foreground">Outcome</dt>
              <dd>{outcome(item)}</dd>
              <dt className="text-muted-foreground">Decided</dt>
              <dd>
                <Time value={item.decidedAt ?? item.expiresAt} />
              </dd>
            </>
          )}
        </dl>
        {!decided && item.canApprove && !rejecting && (
          <div className="flex gap-2 pt-1">
            <Button
              variant="primary"
              disabled={busy}
              aria-label={`Approve the restore on ${item.clusterName}`}
              onClick={() => {
                approve.mutate();
              }}
            >
              Approve
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              aria-label={`Reject the restore on ${item.clusterName}`}
              onClick={() => {
                setRejecting(true);
              }}
            >
              Reject
            </Button>
          </div>
        )}
        {!decided && item.canApprove && rejecting && (
          <form
            className="flex flex-col gap-2 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              reject.mutate();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="font-medium">Reason (optional)</span>
              <textarea
                className={`${inputClass} h-20 py-2`}
                maxLength={500}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                }}
              />
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="destructive" disabled={busy}>
                Confirm rejection
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setRejecting(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {!decided && item.isMine && (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <span className="text-muted-foreground">Waiting for someone else to approve</span>
            <Button
              variant="outline"
              disabled={busy}
              aria-label={`Withdraw the restore on ${item.clusterName}`}
              onClick={() => {
                withdraw.mutate();
              }}
            >
              Withdraw
            </Button>
          </div>
        )}
        <ErrorNote message={failure === undefined ? undefined : errorMessage(failure)} />
      </CardContent>
    </Card>
  );
}
