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

/** Opt-in row selection: a checkbox per row, and `render` gets the selected rows for the actions on them. */
export interface Bulk<T> {
  /** The row's name for screen readers: "Select nightly-1". */
  rowName: (row: T) => string;
  render: (selected: T[], clear: () => void) => ReactNode;
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
  bulk,
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
  bulk?: Bulk<T>;
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
  // Selection is by key, and only rows still on screen count: a row that left the list is not acted on.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const selected = rows.filter((r) => chosen.has(rowKey(r)));
  const allChosen = rows.length > 0 && selected.length === rows.length;
  const toggle = (key: string, on: boolean): void => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    setChosen(next);
  };
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

        {bulk !== undefined && selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-control p-2 text-sm">
            <span>{`${selected.length.toString()} selected`}</span>
            {bulk.render(selected, () => {
              setChosen(new Set());
            })}
            <Button
              variant="outline"
              onClick={() => {
                setChosen(new Set());
              }}
            >
              Clear selection
            </Button>
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {bulk !== undefined && (
                    <th className="w-8 p-2">
                      <input
                        type="checkbox"
                        aria-label={`Select all ${noun} on this page`}
                        checked={allChosen}
                        onChange={(e) => {
                          setChosen(e.target.checked ? new Set(rows.map(rowKey)) : new Set());
                        }}
                      />
                    </th>
                  )}
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
                    {bulk !== undefined && (
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${bulk.rowName(row)}`}
                          checked={chosen.has(rowKey(row))}
                          onChange={(e) => {
                            toggle(rowKey(row), e.target.checked);
                          }}
                        />
                      </td>
                    )}
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
