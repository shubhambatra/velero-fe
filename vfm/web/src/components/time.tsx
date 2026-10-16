import type { ReactElement } from 'react';

/**
 * A moment in the viewer's timezone, with the UTC instant on hover (PLAN.md §11.2).
 * A missing value is an em dash, never "Invalid Date".
 */
export function Time({ value }: { value: string | null | undefined }): ReactElement {
  if (value === null || value === undefined || Number.isNaN(new Date(value).getTime())) {
    return <span aria-label="not available">—</span>;
  }
  const date = new Date(value);
  return (
    <time
      dateTime={date.toISOString()}
      title={`${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`}
    >
      {date.toLocaleString()}
    </time>
  );
}
