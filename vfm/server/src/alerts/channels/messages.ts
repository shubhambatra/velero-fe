import { createHmac } from 'node:crypto';

import type { AlertNotification } from '../notifier';

export type MessageKind = AlertNotification['kind'] | 'test';

export interface MessageInput {
  kind: MessageKind;
  orgId: string;
  rule: { id: string; name: string; type: string };
  cluster: { id: string; name: string };
  event: {
    id: string;
    fingerprint: string;
    payload: Record<string, unknown>;
    firedAt: Date;
    resolvedAt: Date | null;
  };
  /** Where the alert can be looked at, when the deployment knows its own address. */
  link: string | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** A line of text that cannot start another header or line: no control characters at all. */
const line = (v: unknown, max = 300): string =>
  (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const when = (v: unknown): string => {
  const d = typeof v === 'string' ? new Date(v) : null;
  return d !== null && !Number.isNaN(d.getTime()) ? d.toISOString() : 'unknown time';
};

/** One sentence about what is wrong, from the fields the rule type records. */
export function summarize(type: string, p: Record<string, unknown>): string {
  const cluster = line(p.cluster, 100);
  switch (type) {
    case 'BACKUP_FAILED': {
      const reason = line(p.reason);
      return (
        `Backup ${line(p.backup, 100)}${p.schedule ? ` (schedule ${line(p.schedule, 100)})` : ''} ` +
        `${line(p.phase, 40) || 'failed'} on ${cluster} at ${when(p.failedAt)}` +
        (reason === '' ? '.' : `: ${reason}`)
      );
    }
    case 'SCHEDULE_MISSED':
      return (
        `Schedule ${line(p.schedule, 100)} on ${cluster} has produced no backup since ` +
        `${when(p.lastBackupAt)} (allowed ${line(p.allowedHours, 20)} h).`
      );
    case 'AGENT_DISCONNECTED':
      return `The agent of ${cluster} has been disconnected for ${line(p.minutes, 20)} minutes (last seen ${when(p.lastSeenAt)}).`;
    case 'BSL_UNAVAILABLE':
      return `Backup storage location ${line(p.location, 100)} on ${cluster} is unavailable.`;
    case 'BACKUP_EXPIRING':
      return (
        `The newest backup ${line(p.backup, 100)}${p.schedule ? ` of schedule ${line(p.schedule, 100)}` : ''} ` +
        `on ${cluster} ${p.expired === true ? 'has expired' : `expires ${when(p.expiresAt)}`} and no newer one exists.`
      );
    default:
      return `${line(p.cluster, 100)}: a condition of type ${line(type, 40)}.`;
  }
}

const HEAD: Record<MessageKind, string> = {
  fired: 'FIRING',
  renotify: 'STILL FIRING',
  resolved: 'RESOLVED',
  test: 'TEST',
};

export function subject(m: MessageInput): string {
  return `[VFM] ${HEAD[m.kind]}: ${line(m.rule.name, 100)} - ${line(m.cluster.name, 100)}`;
}

export function emailText(m: MessageInput): string {
  const lines = [
    m.kind === 'test'
      ? 'This is a test message from Velero Fleet Manager. If you can read it, this channel works.'
      : summarize(m.rule.type, m.event.payload),
    '',
    `State:   ${HEAD[m.kind]}`,
    `Rule:    ${line(m.rule.name, 100)} (${line(m.rule.type, 40)})`,
    `Cluster: ${line(m.cluster.name, 100)}`,
    `Started: ${m.event.firedAt.toISOString()}`,
  ];
  if (m.event.resolvedAt !== null) lines.push(`Ended:   ${m.event.resolvedAt.toISOString()}`);
  if (m.link !== null) lines.push('', m.link);
  return lines.join('\n') + '\n';
}

/** What a generic webhook receives. Versioned: a receiver can refuse a version it does not know. */
export function webhookBody(m: MessageInput): string {
  return JSON.stringify({
    version: 1,
    kind: m.kind,
    orgId: m.orgId,
    rule: m.rule,
    cluster: m.cluster,
    event: {
      id: m.event.id,
      state: m.event.resolvedAt === null ? 'FIRING' : 'RESOLVED',
      fingerprint: m.event.fingerprint,
      firedAt: m.event.firedAt.toISOString(),
      resolvedAt: m.event.resolvedAt?.toISOString() ?? null,
      payload: m.event.payload,
    },
    summary: m.kind === 'test' ? 'Test message' : summarize(m.rule.type, m.event.payload),
    link: m.link,
  });
}

/** Slack's mrkdwn treats `&`, `<` and `>` as markup, which log-derived text must not reach. */
const slackEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The body Slack and Slack-compatible receivers (Mattermost, Rocket.Chat, Teams relays) take. */
export function slackBody(m: MessageInput): string {
  const text =
    m.kind === 'test'
      ? 'Test message from Velero Fleet Manager.'
      : slackEscape(summarize(m.rule.type, m.event.payload));
  const head = `*${HEAD[m.kind]}* ${slackEscape(line(m.rule.name, 100))} - ${slackEscape(line(m.cluster.name, 100))}`;
  return JSON.stringify({
    text: `${head}\n${text}${m.link === null ? '' : `\n${m.link}`}`,
  });
}

/**
 * `X-VFM-Signature: sha256=<hex>` over `<timestamp>.<body>`. The timestamp is inside the
 * signed text so a captured request cannot be replayed later: a receiver rejects a timestamp
 * that is too old. `X-VFM-Event-Id` lets it ignore a repeat of the same event.
 */
export function sign(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp.toString()}.${body}`).digest('hex')}`;
}

export function webhookHeaders(
  secret: string,
  m: MessageInput,
  body: string,
  now: Date,
): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    'x-vfm-timestamp': timestamp.toString(),
    'x-vfm-signature': sign(secret, timestamp, body),
    'x-vfm-event-id': m.event.id,
    'x-vfm-kind': m.kind,
  };
}
