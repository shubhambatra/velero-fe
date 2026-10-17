import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';

import { LogViewer } from '@/components/log-viewer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, inputClass } from '@/components/ui/field';
import { api } from '@/lib/client';
import {
  DEFAULT_LOG_OPTIONS,
  END_REASONS,
  useLiveLog,
  type LogOptions,
  type LogTarget,
} from '@/lib/log-session';

const TAILS = [100, 200, 1000, 10_000] as const;

interface PanelProps {
  orgId: string;
  clusterId: string;
  target: LogTarget;
  onClose: () => void;
}

/**
 * Follows one container's log. Opening it starts the session, closing it (or leaving the
 * page) ends it. The choices apply to the next start, so changing one restarts the log.
 */
export function LiveLogsPanel({ orgId, clusterId, target, onClose }: PanelProps): ReactElement {
  const live = useLiveLog(orgId, clusterId, target);
  const { start } = live;
  const [options, setOptions] = useState<LogOptions>(DEFAULT_LOG_OPTIONS);
  const { state } = live;

  useEffect(() => {
    start(DEFAULT_LOG_OPTIONS);
    // A new target is a new panel; the options start from their defaults.
    setOptions(DEFAULT_LOG_OPTIONS);
  }, [start]);

  const running = state.phase === 'starting' || state.phase === 'streaming';
  const title = `${target.namespace}/${target.pod}${target.container === undefined ? '' : ` · ${target.container}`}`;

  return (
    <Card aria-label={`Logs of ${title}`}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="font-mono text-base">{title}</CardTitle>
          <Button
            variant="outline"
            onClick={() => {
              live.stop();
              onClose();
            }}
          >
            Close
          </Button>
        </div>
        <CardDescription>
          Read from the cluster as it is written. Nothing is stored: lines produced while this page
          is not connected are not kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label>
            <span className="mb-1 block text-muted-foreground">Start with the last</span>
            <select
              className={inputClass}
              value={options.tailLines}
              onChange={(e) => {
                setOptions({ ...options, tailLines: Number(e.target.value) });
              }}
            >
              {TAILS.map((n) => (
                <option key={n} value={n}>{`${n.toLocaleString()} lines`}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input
              type="checkbox"
              checked={options.timestamps}
              onChange={(e) => {
                setOptions({ ...options, timestamps: e.target.checked });
              }}
            />
            Timestamps
          </label>
          <label className="flex items-center gap-2 pb-2">
            <input
              type="checkbox"
              checked={options.previous}
              onChange={(e) => {
                setOptions({ ...options, previous: e.target.checked });
              }}
            />
            Previous container (read once, not followed)
          </label>
          <Button
            onClick={() => {
              live.start(options);
            }}
          >
            {state.phase === 'idle' ? 'Start' : 'Restart with these'}
          </Button>
          {running && (
            <Button variant="outline" onClick={live.stop}>
              Stop
            </Button>
          )}
        </div>
        <Status state={state} />
        <LogViewer
          snapshot={live.snapshot}
          live={state.phase === 'streaming'}
          text={live.text}
          fileName={`${target.pod}${target.container === undefined ? '' : `_${target.container}`}.log`}
          onClear={live.clear}
          emptyHint={
            state.phase === 'starting' || state.phase === 'streaming'
              ? 'Waiting for the first line…'
              : 'No lines.'
          }
        />
      </CardContent>
    </Card>
  );
}

function Status({ state }: { state: ReturnType<typeof useLiveLog>['state'] }): ReactElement | null {
  switch (state.phase) {
    case 'starting':
      return (
        <p role="status" className="text-sm text-muted-foreground">
          Asking the agent to start…
        </p>
      );
    case 'refused':
      return <ErrorNote message={state.message} />;
    case 'lost':
      return (
        <p role="alert" className="text-sm font-medium text-destructive">
          The connection to the control plane was lost. Lines written meanwhile are not kept.
          Restart to continue.
        </p>
      );
    case 'ended':
      return (
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm">
          <Badge
            tone={state.reason === 'completed' || state.reason === 'stopped' ? 'neutral' : 'warn'}
          >
            Ended
          </Badge>
          <span>{END_REASONS[state.reason] ?? END_REASONS.error}</span>
          {state.message !== '' && <span className="text-muted-foreground">{state.message}</span>}
        </p>
      );
    default:
      return null;
  }
}

interface ShortcutTarget {
  pod: string;
  container: string;
  node: string | null;
}
interface Shortcuts {
  namespace: string | null;
  server: ShortcutTarget[];
  nodeAgent: ShortcutTarget[];
}

/**
 * One-click logs for Velero's own pods. Nothing is shown when there are none or the person
 * may not read logs there: the pod list's own buttons are the way in then.
 */
export function VeleroLogShortcuts({
  orgId,
  clusterId,
  onOpen,
}: {
  orgId: string;
  clusterId: string;
  onOpen: (target: LogTarget) => void;
}): ReactElement | null {
  const query = useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'log-shortcuts'],
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) =>
      api<Shortcuts>(`/orgs/${orgId}/clusters/${clusterId}/log-shortcuts`, { signal }),
  });
  const data = query.data;
  if (data?.namespace == null || data.server.length + data.nodeAgent.length === 0) {
    return null;
  }
  const namespace = data.namespace;
  const open = (t: ShortcutTarget): void => {
    onOpen({ namespace, pod: t.pod, container: t.container });
  };
  return (
    <div
      role="group"
      aria-label="Velero logs"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span className="text-muted-foreground">Velero logs:</span>
      {data.server.map((t) => (
        <Button
          key={t.pod}
          variant="outline"
          onClick={() => {
            open(t);
          }}
        >
          {data.server.length > 1 ? `Velero server (${t.pod})` : 'Velero server'}
        </Button>
      ))}
      {data.nodeAgent.map((t) => (
        <Button
          key={t.pod}
          variant="outline"
          onClick={() => {
            open(t);
          }}
        >
          {`Node agent${t.node === null ? '' : ` on ${t.node}`}`}
        </Button>
      ))}
    </div>
  );
}
