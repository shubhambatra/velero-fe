import type { ReactElement } from 'react';

import { PRODUCT_NAME } from '@vfm/shared';

import { HealthIndicator } from '@/components/health-indicator';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { API_BASE_URL } from '@/lib/api';

/**
 * Fleet overview (PLAN.md §11.1 page 2).
 *
 * The real page — cluster cards, fleet-wide counts, the "needs attention"
 * list — needs enrolled clusters, which arrive in M2. Until then this is an
 * empty state that says what the user can do next (PLAN.md §11.2) rather than
 * a mock-up of data that does not exist (§16 forbids fake completeness).
 */
export function OverviewPage(): ReactElement {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Fleet overview</h1>
        <p className="text-sm text-muted-foreground">
          {PRODUCT_NAME} manages Velero across your Kubernetes clusters.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>No clusters yet</CardTitle>
          <CardDescription>
            Clusters appear here once an agent connects. Enrollment — the generated Helm command and
            the live &ldquo;waiting for agent&rdquo; flow — arrives with the agent protocol (M2).
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Control plane</CardTitle>
          <CardDescription>
            Liveness and readiness are polled continuously, so a control plane that is down is
            visible here and in the header rather than surfacing as a failed action later.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <HealthIndicator />
          <span className="text-muted-foreground">
            API base <span className="font-mono">{API_BASE_URL}</span>
          </span>
        </CardContent>
      </Card>
    </div>
  );
}
