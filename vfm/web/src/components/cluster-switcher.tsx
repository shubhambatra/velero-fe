import { useNavigate, useParams } from '@tanstack/react-router';
import type { ReactElement } from 'react';

import { inputClass } from '@/components/ui/field';
import { useFleet } from '@/lib/use-fleet';
import { useOrgs } from '@/lib/session';

const ALL = '';

/**
 * Header control: jump to any cluster of the active organization, or back to the whole fleet.
 * The current cluster is read from the route, so the control is right after a deep link or a refresh.
 */
export function ClusterSwitcher(): ReactElement | null {
  const { active } = useOrgs(true);
  const fleet = useFleet(active?.id);
  const navigate = useNavigate();
  const params: { clusterId?: string } = useParams({ strict: false });
  const clusters = [...(fleet.data?.clusters ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  // One cluster is not a fleet; the switcher earns its place from two.
  if (clusters.length < 2) return null;

  return (
    <>
      <label htmlFor="cluster-switcher" className="sr-only">
        Cluster
      </label>
      <select
        id="cluster-switcher"
        className={`${inputClass} w-auto max-w-44`}
        value={params.clusterId ?? ALL}
        onChange={(e) => {
          const id = e.target.value;
          void (id === ALL
            ? navigate({ to: '/' })
            : navigate({ to: '/clusters/$clusterId', params: { clusterId: id } }));
        }}
      >
        <option value={ALL}>All clusters ({clusters.length})</option>
        {clusters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.status === 'CONNECTED' ? '' : ` (${c.status.toLowerCase()})`}
          </option>
        ))}
      </select>
    </>
  );
}
