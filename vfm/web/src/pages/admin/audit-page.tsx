import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorNote, Field, inputClass } from '@/components/ui/field';
import { API_BASE_URL } from '@/lib/api';
import { api, errorMessage } from '@/lib/client';
import type { AuditEvent } from '@/lib/types';

interface Filters {
  actorId: string;
  action: string;
  clusterId: string;
  outcome: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { actorId: '', action: '', clusterId: '', outcome: '', from: '', to: '' };

/** Builds the query string; datetime-local values become ISO instants. */
function auditQuery(filters: Filters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const name of Object.keys(EMPTY) as (keyof Filters)[]) {
    const trimmed = filters[name].trim();
    if (trimmed === '') {
      continue;
    }
    params.set(name, name === 'from' || name === 'to' ? new Date(trimmed).toISOString() : trimmed);
  }
  for (const [name, value] of Object.entries(extra)) {
    params.set(name, value);
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export function AuditPage({ orgId }: { orgId: string }): ReactElement {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);

  const events = useInfiniteQuery({
    queryKey: ['org', orgId, 'audit', applied],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<{ events: AuditEvent[]; nextCursor: string | null }>(
        `/orgs/${orgId}/audit${auditQuery(applied, {
          limit: '50',
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        })}`,
        { signal },
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];
  const set = (name: keyof Filters) => (value: string) => {
    setDraft((d) => ({ ...d, [name]: value }));
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Audit log</h1>

      <Card>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied(draft);
            }}
          >
            <Field
              label="Actor ID"
              value={draft.actorId}
              onChange={(e) => {
                set('actorId')(e.target.value);
              }}
            />
            <Field
              label="Action"
              value={draft.action}
              onChange={(e) => {
                set('action')(e.target.value);
              }}
            />
            <Field
              label="Cluster ID"
              value={draft.clusterId}
              onChange={(e) => {
                set('clusterId')(e.target.value);
              }}
            />
            <div className="flex flex-col gap-1">
              <label htmlFor="audit-outcome" className="text-sm font-medium">
                Outcome
              </label>
              <select
                id="audit-outcome"
                className={inputClass}
                value={draft.outcome}
                onChange={(e) => {
                  set('outcome')(e.target.value);
                }}
              >
                <option value="">Any</option>
                <option value="SUCCESS">Success</option>
                <option value="DENIED">Denied</option>
                <option value="FAILED">Failed</option>
              </select>
            </div>
            <Field
              label="From"
              type="datetime-local"
              value={draft.from}
              onChange={(e) => {
                set('from')(e.target.value);
              }}
            />
            <Field
              label="To"
              type="datetime-local"
              value={draft.to}
              onChange={(e) => {
                set('to')(e.target.value);
              }}
            />
            <Button type="submit" variant="primary">
              Apply filters
            </Button>
            <Button
              onClick={() => {
                setDraft(EMPTY);
                setApplied(EMPTY);
              }}
            >
              Clear
            </Button>
            {/* A plain link: the browser downloads the CSV with its session cookie. */}
            <a
              className={buttonVariants({ variant: 'outline' })}
              href={`${API_BASE_URL}/orgs/${orgId}/audit/export${auditQuery(applied)}`}
            >
              Export CSV
            </a>
          </form>
        </CardContent>
      </Card>

      <ErrorNote message={events.isError ? errorMessage(events.error) : undefined} />

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="py-1 pr-3">Time</th>
              <th className="py-1 pr-3">Actor</th>
              <th className="py-1 pr-3">Action</th>
              <th className="py-1 pr-3">Target</th>
              <th className="py-1 pr-3">Outcome</th>
              <th className="py-1">IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="py-1 pr-3">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="py-1 pr-3">{e.actorEmail ?? e.actorId ?? e.actorType}</td>
                <td className="py-1 pr-3 font-mono">{e.action}</td>
                <td className="py-1 pr-3">
                  {e.targetType ?? ''} {e.targetId ?? ''}
                </td>
                <td className="py-1 pr-3">{e.outcome}</td>
                <td className="py-1">{e.ip ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {events.isSuccess && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No events match these filters.</p>
      )}
      {events.hasNextPage && (
        <div>
          <Button
            disabled={events.isFetchingNextPage}
            onClick={() => {
              void events.fetchNextPage();
            }}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
