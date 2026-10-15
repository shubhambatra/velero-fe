import { Navigate } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { canAdminister } from '@/lib/types';
import { errorMessage } from '@/lib/client';
import { useOrgs, useSession } from '@/lib/session';

function Notice({ title, children }: { title: string; children?: ReactNode }): ReactElement {
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {children !== undefined && <CardDescription>{children}</CardDescription>}
      </CardHeader>
    </Card>
  );
}

/** Unauthenticated goes to /login; a session owing a second factor goes to /mfa. */
export function RequireSession({ children }: { children: ReactNode }): ReactElement {
  const session = useSession();
  switch (session.status) {
    case 'loading':
      return <p className="text-sm text-muted-foreground">Loading…</p>;
    case 'error':
      return (
        <Notice title="Could not reach the control plane">{errorMessage(session.error)}</Notice>
      );
    case 'anonymous':
      return <Navigate to="/login" />;
    case 'mfa':
      return <Navigate to="/mfa" />;
    case 'ready':
      return <>{children}</>;
  }
}

/** Org admin pages: hidden from MEMBER role (the server enforces the same). */
export function RequireAdmin({
  children,
}: {
  children: (orgId: string) => ReactNode;
}): ReactElement {
  const { active, isPending } = useOrgs(true);
  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (active === undefined) {
    return <Notice title="No organization">You do not belong to an organization yet.</Notice>;
  }
  if (!canAdminister(active.orgRole)) {
    return <Notice title="Not available">This page is for organization owners and admins.</Notice>;
  }
  return <>{children(active.id)}</>;
}
