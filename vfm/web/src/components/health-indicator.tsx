import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { healthQueryOptions, type HealthState } from '@/lib/health';

interface Presentation {
  label: string;
  tone: 'ok' | 'warn' | 'error';
  dot: string;
}

const PRESENTATION: Record<HealthState, Presentation> = {
  connected: { label: 'Connected', tone: 'ok', dot: 'bg-ok' },
  degraded: { label: 'Degraded', tone: 'warn', dot: 'bg-warn' },
  unreachable: { label: 'Unreachable', tone: 'error', dot: 'bg-error' },
};

/**
 * Live control plane connectivity in the header (PLAN.md §11.1).
 *
 * The control plane is a separate deployable: during local development it is
 * routinely not running, and in production it can be up but not ready. Both
 * are states this renders, not errors it raises — `fetchHealth` encodes
 * failure as data so an unreachable server can never trip the error boundary
 * or leave the header spinning.
 *
 * The colour is backed by a word in every state, because colour alone is not
 * an accessible signal.
 */
export function HealthIndicator({ className }: { className?: string | undefined }): ReactElement {
  const { data } = useQuery(healthQueryOptions);

  if (data === undefined) {
    return (
      <div role="status" className={className}>
        <Badge tone="neutral" title="Contacting the control plane…">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-muted-foreground" />
          Checking…
        </Badge>
      </div>
    );
  }

  const { label, tone, dot } = PRESENTATION[data.state];

  return (
    <div role="status" className={className}>
      <Badge tone={tone} title={data.detail}>
        <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', dot)} />
        {label}
      </Badge>
      {/*
        The visible pill is terse because it sits in the header; the detail and
        the request id are announced to assistive technology and available in
        the tooltip, which is where an operator looks when something is wrong.
      */}
      <span className="sr-only">
        {` Control plane status: ${label}. ${data.detail}`}
        {data.requestId === undefined ? '' : ` Request id ${data.requestId}.`}
      </span>
    </div>
  );
}
