import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { useRefreshInterval } from '@/lib/events';

interface CommandRow {
  id: string;
  op: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  finishedAt: string | null;
  deadlineAt: string;
}

const TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'error'> = {
  SUCCEEDED: 'ok',
  FAILED: 'error',
  TIMED_OUT: 'error',
  REJECTED: 'error',
  CANCELLED: 'warn',
  PENDING_APPROVAL: 'warn',
};

/** "backup.create" is how the API names it; people read "backup create". */
const opLabel = (op: string): string => op.replace(/[._]/g, ' ');

const seconds = (from: string, to: string | null): string => {
  if (to === null) return '—';
  const s = Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 1000);
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${String(Math.round(s / 60))} min`;
};

/**
 * The commands sent to this cluster and how each one went (PLAN.md section 11.1 page 3, "Activity"). A
 * command that succeeded is not a backup that succeeded: this lists what the agent was asked to
 * do, the backup's own phase is on the Backups tab.
 */
export function ClusterActivityPage({
  orgId,
  clusterId,
}: {
  orgId: string;
  clusterId: string;
}): ReactElement {
  const interval = useRefreshInterval();
  const commands = useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'commands'],
    refetchInterval: interval,
    queryFn: ({ signal }) =>
      api<{ commands: CommandRow[] }>(`/orgs/${orgId}/clusters/${clusterId}/commands`, { signal }),
  });
  const rows = commands.data?.commands ?? [];

  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="activity">
      <p className="text-sm text-muted-foreground">
        The most recent commands sent to this cluster&rsquo;s agent. A command finishing means the
        agent did what it was asked; whether Velero then succeeded is on the Backups and Restores
        tabs.
      </p>
      <ErrorNote message={commands.isError ? errorMessage(commands.error) : undefined} />
      <Card>
        <CardContent className="overflow-x-auto p-0">
          {commands.isSuccess && rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nothing has been sent to this cluster yet. Creating a backup, a schedule or a restore
              will show up here.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="p-2">Command</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Sent</th>
                  <th className="p-2">Took</th>
                  <th className="p-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="p-2 font-medium">{opLabel(c.op)}</td>
                    <td className="p-2">
                      <Badge tone={TONE[c.status] ?? 'neutral'}>
                        {c.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="p-2">
                      <Time value={c.createdAt} />
                    </td>
                    <td className="p-2">{seconds(c.createdAt, c.finishedAt)}</td>
                    <td className="p-2">
                      {c.errorMessage ??
                        (c.attempts > 1 ? `delivered ${String(c.attempts)} times` : '—')}
                      {c.errorCode !== null && (
                        <span className="ml-1 font-mono text-xs text-muted-foreground">
                          {c.errorCode}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </ClusterShell>
  );
}
