import type { AuditEventView } from './audit.service';

/**
 * RFC 4180 CSV cell escaping, plus the spreadsheet formula guard.
 *
 * A cell beginning with `=`, `+`, `-`, `@`, tab or CR is executed as a formula
 * by Excel and LibreOffice. Audit rows contain attacker-influenced strings (a
 * user agent, an action target), and an export is opened by exactly the people
 * with the most access, so such cells are prefixed with `'` to defuse them.
 */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) {
    text = '';
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = value.toString();
  } else {
    text = '';
  }

  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

export const AUDIT_CSV_HEADER = [
  'time',
  'actor_type',
  'actor_id',
  'actor_email',
  'action',
  'target_type',
  'target_id',
  'cluster_id',
  'outcome',
  'ip',
  'user_agent',
  'request_id',
  'details',
] as const;

export const auditCsvLine = (e: AuditEventView): string =>
  csvRow([
    e.createdAt,
    e.actorType,
    e.actorId,
    e.actorEmail,
    e.action,
    e.targetType,
    e.targetId,
    e.clusterId,
    e.outcome,
    e.ip,
    e.userAgent,
    e.requestId,
    e.details,
  ]);
