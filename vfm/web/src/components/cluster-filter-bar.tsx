import type { ReactElement } from 'react';

import { inputClass } from '@/components/ui/field';
import type { ClusterRow, ClusterStatus } from '@/lib/fleet';
import { labelOptions, type ClusterFilter } from '@/lib/fleet-view';

const STATUSES: ClusterStatus[] = ['CONNECTED', 'DISCONNECTED', 'ENROLLED', 'PENDING', 'DISABLED'];

/** Narrow the clusters a fleet view shows: by name or label text, by status, by one label (a group such as env=prod). */
export function ClusterFilterBar({
  clusters,
  value,
  onChange,
}: {
  clusters: readonly ClusterRow[];
  value: ClusterFilter;
  onChange: (next: ClusterFilter) => void;
}): ReactElement {
  const labels = labelOptions(clusters);
  return (
    <div role="search" aria-label="Filter clusters" className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="fleet-q" className="text-xs text-muted-foreground">
          Name or label
        </label>
        <input
          id="fleet-q"
          type="search"
          className={`${inputClass} w-52`}
          value={value.q}
          onChange={(e) => {
            onChange({ ...value, q: e.target.value });
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="fleet-status" className="text-xs text-muted-foreground">
          Status
        </label>
        <select
          id="fleet-status"
          className={`${inputClass} w-auto`}
          value={value.status}
          onChange={(e) => {
            onChange({ ...value, status: e.target.value as ClusterStatus | '' });
          }}
        >
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      {labels.length > 0 && (
        <div className="flex flex-col gap-1">
          <label htmlFor="fleet-label" className="text-xs text-muted-foreground">
            Group (label)
          </label>
          <select
            id="fleet-label"
            className={`${inputClass} w-auto`}
            value={value.label}
            onChange={(e) => {
              onChange({ ...value, label: e.target.value });
            }}
          >
            <option value="">All groups</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
