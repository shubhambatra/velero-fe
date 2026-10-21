import { v7 as uuidv7 } from 'uuid';

/**
 * Primary keys are UUIDv7 (PLAN.md §9).
 *
 * v7 embeds a millisecond timestamp in its high bits, so ids sort by creation
 * time. That matters here because PLAN.md §10 specifies cursor-based
 * pagination: a time-sortable primary key makes the cursor a single indexed
 * column instead of a composite of `created_at` plus a tiebreaker. It also
 * keeps B-tree inserts append-mostly, unlike v4.
 *
 * Generated in application code rather than by Postgres: `gen_random_uuid()`
 * is v4, and a native v7 generator would mean a server extension that
 * air-gapped and managed installs cannot be assumed to have.
 */
export function newId(): string {
  return uuidv7();
}
