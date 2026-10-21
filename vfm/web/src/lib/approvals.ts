import { useQuery } from '@tanstack/react-query';

import { api } from './client';

/** Restore approval as the control plane returns it (PLAN.md §8.4, §16 day 35). */

export interface Person {
  id: string;
  email: string;
  name: string | null;
}

export interface ApprovalItem {
  id: string;
  clusterId: string;
  clusterName: string;
  status: string;
  requestedBy: Person | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  approvedBy: Person | null;
  rejectedBy: Person | null;
  decisionNote: string | null;
  canApprove: boolean;
  isMine: boolean;
  summary: {
    backupName: string | null;
    scheduleName: string | null;
    namespaces: string[];
    namespaceMapping: Record<string, string>;
    includesClusterResources: boolean;
    existingResourcePolicy: string | null;
    restorePVs: boolean | null;
  };
}

export interface ApprovalPolicy {
  required: boolean;
  fromOrg: boolean;
  fromCluster: boolean;
}

export const who = (p: Person | null): string =>
  p === null ? 'someone who has left' : (p.name ?? p.email);

/** "a → b" for each mapped namespace; the rest as they are. */
export function namespaceText(namespaces: string[], mapping: Record<string, string>): string {
  if (namespaces.length === 0 || namespaces.includes('*')) return 'all namespaces';
  return namespaces.map((n) => (mapping[n] === undefined ? n : `${n} → ${mapping[n]}`)).join(', ');
}

/** How an undecided or decided request ended, in words. */
export function outcome(item: ApprovalItem): string {
  if (item.status === 'REJECTED') {
    return `Rejected by ${who(item.rejectedBy)}${item.decisionNote === null ? '' : `: ${item.decisionNote}`}`;
  }
  if (item.approvedBy !== null) return `Approved by ${who(item.approvedBy)}`;
  if (item.status === 'TIMED_OUT') return 'Expired: nobody decided in time';
  if (item.status === 'CANCELLED') return 'Withdrawn by the requester';
  return 'Waiting for approval';
}

/** How many waiting requests the caller may decide, for the navigation badge. */
export function useWaitingCount(orgId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['org', orgId, 'approvals', 'count'],
    enabled: enabled && orgId !== undefined,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: ({ signal }) =>
      api<{ waiting: number }>(`/orgs/${orgId ?? ''}/approvals/count`, { signal }),
  });
}

export function useApprovalPolicy(orgId: string, clusterId: string) {
  return useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'restore-approval'],
    queryFn: ({ signal }) =>
      api<ApprovalPolicy>(`/orgs/${orgId}/clusters/${clusterId}/restore-approval`, { signal }),
  });
}
