import { useEffect, useState, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorNote, inputClass } from '@/components/ui/field';
import { errorMessage } from '@/lib/client';
import { useResourceList, type Filters } from '@/lib/resources';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
}

export interface Option {
  label: string;
  /** What is sent: for a phase this may be a comma list of phases. */
  value: string;
}

export interface Extra {
  key: string;
  label: string;
  options: Option[];
}

/** A filter box that waits for the typing to stop, so each keystroke is not a request. */
function useDebounced(value: string, ms = 300): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(t);
    };
  }, [value, ms]);
  return settled;
}

/**
 * A list read from the API with a filter bar, a sort, and "Load more" (PLAN.md §11.1).
 *
 * It distinguishes three empties, because they ask the reader to do different things:
 * nothing exists yet, nothing matches the filters, and the rows are still loading.
 */
export function ResourceList<T>({
  orgId,
  clusterId,
  path,
  noun,
  columns,
  rowKey,
  sorts,
  defaultSort,
  defaultOrder = 'desc',
  phases,
  extras = [],
  initialExtra,
  emptyHint,
}: {
  orgId: string;
  clusterId: string;
  path: string;
  /** Lower-case plural, for messages: "backups". */
  noun: string;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  sorts: Option[];
  defaultSort: string;
  defaultOrder?: 'asc' | 'desc';
  phases?: Option[];
  extras?: Extra[];
  /** Filter values the list starts with (for example a namespace chosen elsewhere). */
  initialExtra?: Record<string, string> | undefined;
  emptyHint: string;
}): ReactElement {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState('');
  const [sort, setSort] = useState(defaultSort);
  const [order, setOrder] = useState<'asc' | 'desc'>(defaultOrder);
  const [extra, setExtra] = useState<Record<string, string>>(initialExtra ?? {});
  const q = useDebounced(text.trim());

  const filters: Filters = { q, phase, sort, order, ...extra };
  const list = useResourceList<T>(orgId, clusterId, path, filters);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = q !== '' || phase !== '' || Object.values(extra).some((v) => v !== '');

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
          }}
          aria-label={`Filter ${noun}`}
        >
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input
              type="search"
              className={inputClass}
              value={text}
              placeholder={`Search ${noun}`}
              onChange={(e) => {
                setText(e.target.value);
              }}
            />
          </label>
          {phases !== undefined && (
            <label className="flex flex-col gap-1 text-sm">
              Phase
              <select
                className={inputClass}
                value={phase}
                onChange={(e) => {
                  setPhase(e.target.value);
                }}
              >
                <option value="">Any</option>
                {phases.map((p) => (
                  <option key={p.label} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {extras.map((x) => (
            <label key={x.key} className="flex flex-col gap-1 text-sm">
              {x.label}
              <select
                className={inputClass}
                value={extra[x.key] ?? ''}
                onChange={(e) => {
                  setExtra({ ...extra, [x.key]: e.target.value });
                }}
              >
                <option value="">Any</option>
                {x.options.map((o) => (
                  <option key={o.label} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="flex flex-col gap-1 text-sm">
            Sort by
            <select
              className={inputClass}
              value={sort}
              onChange={(e) => {
                setSort(e.target.value);
              }}
            >
              {sorts.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            aria-label={
              order === 'desc'
                ? 'Descending, switch to ascending'
                : 'Ascending, switch to descending'
            }
            onClick={() => {
              setOrder(order === 'desc' ? 'asc' : 'desc');
            }}
          >
            {order === 'desc' ? '↓ Newest first' : '↑ Oldest first'}
          </Button>
        </form>

        <ErrorNote message={list.isError ? errorMessage(list.error) : undefined} />

        {list.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}

        {list.isSuccess && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {filtered ? `No ${noun} match these filters.` : emptyHint}
          </p>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.header} className="p-2">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={rowKey(row)} className="border-t border-control align-top">
                    {columns.map((c) => (
                      <td key={c.header} className="p-2">
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {list.hasNextPage && (
          <div>
            <Button
              variant="outline"
              disabled={list.isFetchingNextPage}
              onClick={() => {
                void list.fetchNextPage();
              }}
            >
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
