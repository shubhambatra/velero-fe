import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorNote, inputClass } from '@/components/ui/field';
import { RULE_TYPES, eventSummary, type AlertEventRow } from '@/lib/alerts';
import { api, errorMessage } from '@/lib/client';

/** What has fired and what became of the messages (PLAN.md §16 day 33). */
export function HistoryTab({ orgId }: { orgId: string }): ReactElement {
  const [state, setState] = useState<'' | 'FIRING' | 'RESOLVED'>('');
  const events = useInfiniteQuery({
    queryKey: ['org', orgId, 'alert-events', state],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (state !== '') params.set('state', state);
      if (pageParam !== undefined) params.set('cursor', pageParam);
      return api<{ events: AlertEventRow[]; nextCursor: string | null }>(
        `/orgs/${orgId}/alerts/events?${params.toString()}`,
        { signal },
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Show alerts</span>
        <select
          className={inputClass}
          value={state}
          onChange={(e) => {
            setState(e.target.value as typeof state);
          }}
        >
          <option value="">All alerts</option>
          <option value="FIRING">Firing now</option>
          <option value="RESOLVED">Resolved</option>
        </select>
      </label>
      <ErrorNote message={events.isError ? errorMessage(events.error) : undefined} />
      {events.isSuccess && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {state === 'FIRING' ? 'Nothing is firing.' : 'Nothing has fired yet.'}
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="p-2">State</th>
                <th className="p-2">What</th>
                <th className="p-2">Started</th>
                <th className="p-2">Ended</th>
                <th className="p-2">Messages</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-border align-top last:border-0">
                  <td className="p-2">
                    <Badge tone={e.state === 'FIRING' ? 'error' : 'ok'}>
                      {e.state === 'FIRING' ? 'Firing' : 'Resolved'}
                    </Badge>
                  </td>
                  <td className="p-2">
                    <div className="font-medium">
                      {e.ruleName ?? 'deleted rule'}
                      {e.ruleType !== null && (
                        <span className="font-normal text-muted-foreground">
                          {` · ${RULE_TYPES[e.ruleType].label}`}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {e.clusterName ?? 'deleted cluster'}
                    </div>
                    <div className="break-words text-xs">{eventSummary(e.ruleType, e.payload)}</div>
                  </td>
                  <td className="p-2">
                    <Time value={e.firedAt} />
                  </td>
                  <td className="p-2">
                    <Time value={e.resolvedAt} />
                  </td>
                  <td className="p-2">
                    {e.deliveries.length === 0 ? (
                      <span className="text-muted-foreground">
                        {e.lastNotifiedAt === null ? 'none sent' : 'sent'}
                      </span>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {e.deliveries.map((d, i) => (
                          <li key={i} className={d.ok ? '' : 'text-destructive'}>
                            <span aria-hidden>{d.ok ? '✓ ' : '✗ '}</span>
                            <span className="sr-only">{d.ok ? 'Delivered: ' : 'Failed: '}</span>
                            {`${d.kind} · ${d.channelName}`}
                            {d.error !== null && <span className="block text-xs">{d.error}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {events.hasNextPage && (
        <div>
          <Button
            variant="outline"
            disabled={events.isFetchingNextPage}
            onClick={() => {
              void events.fetchNextPage();
            }}
          >
            Show older
          </Button>
        </div>
      )}
    </div>
  );
}
