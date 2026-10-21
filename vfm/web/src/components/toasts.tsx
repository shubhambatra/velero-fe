import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/client';

import { ToastContext, type Follow } from './toast-context';

interface CommandState {
  id: string;
  status: string;
  errorMessage: string | null;
  result: { kind?: string; name?: string } | null;
}

interface Toast extends Follow {
  key: number;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);
const DISMISS_AFTER_MS = 10_000;

const STATUS_TEXT: Record<string, string> = {
  QUEUED: 'Waiting for the agent…',
  SENT: 'Sent to the agent…',
  ACKED: 'The agent accepted it…',
  RUNNING: 'Running…',
  SUCCEEDED: 'Done.',
  TIMED_OUT: 'The agent did not answer in time. Is it connected?',
  CANCELLED: 'Cancelled.',
};

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const follow = useCallback((toast: Follow) => {
    setToasts((all) =>
      all.some((t) => t.commandId === toast.commandId)
        ? all
        : [...all, { ...toast, key: Date.now() + Math.random() }],
    );
  }, []);
  const dismiss = useCallback((key: number) => {
    setToasts((all) => all.filter((t) => t.key !== key));
  }, []);
  const value = useMemo(() => ({ follow }), [follow]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.key} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (key: number) => void;
}): ReactElement {
  const client = useQueryClient();
  const command = useQuery<CommandState>({
    queryKey: ['org', toast.orgId, 'cluster', toast.clusterId, 'command', toast.commandId],
    refetchInterval: (query) =>
      query.state.data !== undefined && TERMINAL.has(query.state.data.status) ? false : 1000,
    // The user may be looking at another tab while the agent works.
    refetchIntervalInBackground: true,
    queryFn: ({ signal }) =>
      api<CommandState>(
        `/orgs/${toast.orgId}/clusters/${toast.clusterId}/commands/${toast.commandId}`,
        {
          signal,
        },
      ),
  });
  const status = command.data?.status ?? 'QUEUED';
  const done = TERMINAL.has(status);
  const failed = status === 'FAILED' || status === 'TIMED_OUT';

  useEffect(() => {
    if (status === 'SUCCEEDED') {
      // Backups, restores and schedules change; the live stream usually beats this.
      void client.invalidateQueries({
        queryKey: ['org', toast.orgId, 'cluster', toast.clusterId],
      });
      const timer = setTimeout(() => {
        onDismiss(toast.key);
      }, DISMISS_AFTER_MS);
      return () => {
        clearTimeout(timer);
      };
    }
    return undefined;
  }, [status, client, onDismiss, toast.key, toast.orgId, toast.clusterId]);

  const result = command.data?.result;
  const text =
    status === 'FAILED'
      ? `Failed: ${command.data?.errorMessage ?? 'the agent reported an error.'}`
      : (STATUS_TEXT[status] ?? status);

  return (
    <div
      className="pointer-events-auto rounded-lg border border-border bg-card p-3 text-sm text-card-foreground shadow"
      data-status={status}
    >
      <p className="font-medium">{toast.title}</p>
      <p className={failed ? 'text-destructive' : 'text-muted-foreground'}>{text}</p>
      {status === 'SUCCEEDED' && result?.kind === 'Backup' && result.name !== undefined && (
        <p>
          <Link
            to="/clusters/$clusterId/backups/$name"
            params={{ clusterId: toast.clusterId, name: result.name }}
            className="underline"
          >
            {`Open ${result.name}`}
          </Link>
        </p>
      )}
      {status === 'SUCCEEDED' && result?.kind === 'Restore' && result.name !== undefined && (
        <p>
          <Link
            to="/clusters/$clusterId/restores/$name"
            params={{ clusterId: toast.clusterId, name: result.name }}
            className="underline"
          >
            {`Open ${result.name}`}
          </Link>
        </p>
      )}
      {status === 'SUCCEEDED' && result?.kind === 'DeletedRestore' && (
        <p className="text-muted-foreground">
          The restore was deleted. What it restored stays in the cluster.
        </p>
      )}
      {status === 'SUCCEEDED' && result?.kind === 'DeletedSchedule' && (
        <p className="text-muted-foreground">The schedule was deleted. The backups it made stay.</p>
      )}
      {status === 'SUCCEEDED' && result?.kind === 'DeleteBackupRequest' && (
        <p className="text-muted-foreground">
          Velero is removing the backup and its data; it leaves the list when it is done.
        </p>
      )}
      {done && (
        <Button
          variant="ghost"
          onClick={() => {
            onDismiss(toast.key);
          }}
        >
          Dismiss
        </Button>
      )}
    </div>
  );
}
