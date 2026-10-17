/** Alert rules, channels and history as the control plane returns them (PLAN.md §16 days 32–33). */

export type RuleType =
  | 'BACKUP_FAILED'
  | 'SCHEDULE_MISSED'
  | 'AGENT_DISCONNECTED'
  | 'BSL_UNAVAILABLE'
  | 'BACKUP_EXPIRING';

export interface ParamField {
  key: string;
  label: string;
  kind: 'int' | 'number' | 'bool';
  default: number | boolean;
  min?: number;
  max?: number;
  unit?: string;
  hint?: string;
}

const RENOTIFY: ParamField = {
  key: 'renotifyMinutes',
  label: 'Repeat while it lasts, every',
  kind: 'int',
  default: 240,
  min: 0,
  max: 10_080,
  unit: 'minutes',
  hint: '0 = tell once, and again only when it ends',
};

export const RULE_TYPES: Record<
  RuleType,
  { label: string; description: string; fields: ParamField[] }
> = {
  BACKUP_FAILED: {
    label: 'Backup failed',
    description:
      'A backup (or the latest of a schedule) failed and no later backup of the schedule has completed.',
    fields: [
      {
        key: 'lookbackHours',
        label: 'Only failures from the last',
        kind: 'int',
        default: 24,
        min: 1,
        max: 720,
        unit: 'hours',
      },
      {
        key: 'includePartiallyFailed',
        label: 'Include partially failed backups',
        kind: 'bool',
        default: true,
      },
      RENOTIFY,
    ],
  },
  SCHEDULE_MISSED: {
    label: 'Schedule missed',
    description: 'A schedule has produced no backup within its longest interval times this factor.',
    fields: [
      {
        key: 'factor',
        label: 'Late after',
        kind: 'number',
        default: 1.5,
        min: 1,
        max: 10,
        unit: '× the interval',
      },
      RENOTIFY,
    ],
  },
  AGENT_DISCONNECTED: {
    label: 'Agent disconnected',
    description: 'A cluster’s agent has not been connected for this long.',
    fields: [
      {
        key: 'minutes',
        label: 'Disconnected for',
        kind: 'int',
        default: 10,
        min: 1,
        max: 10_080,
        unit: 'minutes',
      },
      RENOTIFY,
    ],
  },
  BSL_UNAVAILABLE: {
    label: 'Storage location unavailable',
    description: 'Velero reports a backup storage location as Unavailable.',
    fields: [RENOTIFY],
  },
  BACKUP_EXPIRING: {
    label: 'Backups about to expire',
    description:
      'The newest backup of a schedule expires soon and no newer one exists to replace it.',
    fields: [
      {
        key: 'withinDays',
        label: 'Expiring within',
        kind: 'int',
        default: 3,
        min: 1,
        max: 365,
        unit: 'days',
      },
      RENOTIFY,
    ],
  },
};

export const RULE_TYPE_ORDER = Object.keys(RULE_TYPES) as RuleType[];

export const defaultParams = (type: RuleType): Record<string, number | boolean> =>
  Object.fromEntries(RULE_TYPES[type].fields.map((f) => [f.key, f.default]));

export interface AlertRule {
  id: string;
  name: string;
  type: RuleType;
  scope: { clusterIds?: string[] };
  params: Record<string, number | boolean>;
  channelIds: string[];
  enabled: boolean;
  firing: number;
}

export type ChannelType = 'EMAIL' | 'WEBHOOK' | 'SLACK_WEBHOOK';

export const CHANNEL_LABEL: Record<ChannelType, string> = {
  EMAIL: 'Email',
  WEBHOOK: 'Webhook (signed)',
  SLACK_WEBHOOK: 'Slack-compatible webhook',
};

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  config: { to?: string[]; destination?: string; signed?: boolean };
  /** Present only in the answer to the request that made or rotated a webhook's secret. */
  secret?: string;
}

export interface Delivery {
  channelId: string | null;
  channelName: string;
  kind: string;
  ok: boolean;
  error: string | null;
  createdAt: string;
}

export interface AlertEventRow {
  id: string;
  ruleId: string;
  ruleName: string | null;
  ruleType: RuleType | null;
  clusterId: string;
  clusterName: string | null;
  state: 'FIRING' | 'RESOLVED';
  fingerprint: string;
  payload: Record<string, unknown>;
  firedAt: string;
  resolvedAt: string | null;
  lastNotifiedAt: string | null;
  deliveries: Delivery[];
}

/** Recipients typed as a list: commas, semicolons, spaces or new lines between addresses. */
export const parseRecipients = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');

const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';

/** One line on what an event is about, from the fields its rule recorded. */
export function eventSummary(type: RuleType | null, p: Record<string, unknown>): string {
  switch (type) {
    case 'BACKUP_FAILED':
      return `Backup ${str(p.backup)}${p.schedule ? ` (schedule ${str(p.schedule)})` : ''} ${str(p.phase).toLowerCase() || 'failed'}${p.reason ? `: ${str(p.reason)}` : ''}`;
    case 'SCHEDULE_MISSED':
      return `Schedule ${str(p.schedule)} has made no backup since ${str(p.lastBackupAt) || 'it was created'}`;
    case 'AGENT_DISCONNECTED':
      return `Agent disconnected for ${str(p.minutes)} minutes`;
    case 'BSL_UNAVAILABLE':
      return `Storage location ${str(p.location)} is unavailable`;
    case 'BACKUP_EXPIRING':
      return `Backup ${str(p.backup)} ${p.expired === true ? 'has expired' : 'expires soon'} with no newer one`;
    default:
      return '';
  }
}
