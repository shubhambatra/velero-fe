/** Response shapes of the control-plane endpoints the M1 UI calls. */

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type MfaPendingReason = 'enrolment' | 'challenge';

export interface User {
  id: string;
  email: string;
  name: string | null;
  isPlatformAdmin: boolean;
  mfaEnabled: boolean;
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  orgRole: OrgRole;
  active: boolean;
}

export interface OrgDetail {
  id: string;
  name: string;
  slug: string;
  orgRole: OrgRole;
  settings: { mfaRequired?: boolean; allowBackupContentDownload?: boolean };
}

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  orgRole: OrgRole;
  mfaEnabled: boolean;
  joinedAt: string;
}

export interface Invite {
  id: string;
  email: string;
  orgRole: OrgRole;
  expiresAt: string;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
}

export interface TeamMember {
  id: string;
  email: string;
  name: string | null;
}

export interface Mapping {
  group: string;
  teamId: string;
}

export interface Provider {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  groupClaim: string | null;
  mappings: Mapping[];
  jitEnabled: boolean;
  enabled: boolean;
}

export interface AuditEvent {
  id: string;
  actorType: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  clusterId: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILED';
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}

export const canAdminister = (role: OrgRole | undefined): boolean =>
  role === 'OWNER' || role === 'ADMIN';
