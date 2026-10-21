import { useQuery } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/client';
import type { Channel } from '@/lib/alerts';

import { ChannelsTab } from './alerts-channels';
import { HistoryTab } from './alerts-history';
import { RulesTab } from './alerts-rules';

const TABS = [
  { id: 'rules', label: 'Rules' },
  { id: 'channels', label: 'Channels' },
  { id: 'history', label: 'History' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export interface Named {
  id: string;
  name: string;
}

/**
 * Alerts (PLAN.md §11.1 page 11): what to watch, where to tell people, and what has happened.
 * Owner and Admin only; the control plane enforces it, the navigation only hides it.
 */
export function AlertsPage({ orgId }: { orgId: string }): ReactElement {
  const [tab, setTab] = useState<Tab>('rules');
  // Both tabs of rules and history need these, so they are read once here.
  const clusters = useQuery({
    queryKey: ['org', orgId, 'clusters'],
    queryFn: ({ signal }) => api<{ clusters: Named[] }>(`/orgs/${orgId}/clusters`, { signal }),
  });
  const channels = useQuery({
    queryKey: ['org', orgId, 'channels'],
    queryFn: ({ signal }) => api<{ channels: Channel[] }>(`/orgs/${orgId}/channels`, { signal }),
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Alerts</h1>
      <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <Button
            key={t.id}
            variant={tab === t.id ? 'primary' : 'outline'}
            aria-pressed={tab === t.id}
            onClick={() => {
              setTab(t.id);
            }}
          >
            {t.label}
          </Button>
        ))}
      </div>
      {tab === 'rules' && (
        <RulesTab
          orgId={orgId}
          clusters={clusters.data?.clusters ?? []}
          channels={channels.data?.channels ?? []}
          goToChannels={() => {
            setTab('channels');
          }}
        />
      )}
      {tab === 'channels' && <ChannelsTab orgId={orgId} />}
      {tab === 'history' && <HistoryTab orgId={orgId} />}
    </div>
  );
}
