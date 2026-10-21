/* eslint-disable no-control-regex, @typescript-eslint/no-explicit-any -- the tests read JSON bodies untyped and look for control characters on purpose */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  emailText,
  sign,
  slackBody,
  subject,
  summarize,
  webhookBody,
  webhookHeaders,
  type MessageInput,
} from './messages';

const message = (over: Partial<MessageInput> = {}): MessageInput => ({
  kind: 'fired',
  orgId: 'o1',
  rule: { id: 'r1', name: 'Failed backups', type: 'BACKUP_FAILED' },
  cluster: { id: 'c1', name: 'prod-eu' },
  event: {
    id: 'e1',
    fingerprint: 'backup-failed:velero/nightly',
    payload: {
      cluster: 'prod-eu',
      backup: 'nightly-1',
      schedule: 'nightly',
      phase: 'Failed',
      failedAt: '2026-10-17T02:00:00.000Z',
      reason: 'BSL unavailable',
    },
    firedAt: new Date('2026-10-17T02:01:00Z'),
    resolvedAt: null,
  },
  link: 'https://vfm.example/alerts',
  ...over,
});

describe('summarize', () => {
  it.each([
    [
      'BACKUP_FAILED',
      { cluster: 'c', backup: 'b', schedule: 's', phase: 'Failed', reason: 'why' },
      /Backup b \(schedule s\) Failed on c.*: why/,
    ],
    [
      'SCHEDULE_MISSED',
      { cluster: 'c', schedule: 's', allowedHours: 36 },
      /Schedule s on c has produced no backup/,
    ],
    [
      'AGENT_DISCONNECTED',
      { cluster: 'c', minutes: 14 },
      /agent of c has been disconnected for 14 minutes/,
    ],
    [
      'BSL_UNAVAILABLE',
      { cluster: 'c', location: 'default' },
      /location default on c is unavailable/,
    ],
    [
      'BACKUP_EXPIRING',
      { cluster: 'c', backup: 'b', expired: false, expiresAt: '2026-10-18T00:00:00Z' },
      /expires 2026-10-18/,
    ],
    ['BACKUP_EXPIRING', { cluster: 'c', backup: 'b', expired: true }, /has expired/],
    ['SOMETHING_NEW', { cluster: 'c' }, /condition of type SOMETHING_NEW/],
  ])('%s', (type, payload, expected) => {
    expect(summarize(type, payload)).toMatch(expected);
  });

  it('survives a payload with nothing in it', () => {
    for (const type of [
      'BACKUP_FAILED',
      'SCHEDULE_MISSED',
      'AGENT_DISCONNECTED',
      'BSL_UNAVAILABLE',
      'BACKUP_EXPIRING',
    ]) {
      expect(() => summarize(type, {})).not.toThrow();
    }
  });
});

describe('what a person reads', () => {
  it('has one line for the subject, whatever the names contain', () => {
    const s = subject(
      message({
        rule: { id: 'r', name: 'x\r\nBcc: evil@example.com', type: 'BACKUP_FAILED' },
        cluster: { id: 'c', name: 'a\nb' },
      }),
    );
    expect(s).not.toMatch(/[\r\n]/);
    expect(s).toMatch(/^\[VFM\] FIRING: /);
  });

  it('says what happened, when, and where to look', () => {
    const text = emailText(message());
    expect(text).toMatch(/Backup nightly-1 \(schedule nightly\) Failed on prod-eu/);
    expect(text).toMatch(/State: {3}FIRING/);
    expect(text).toMatch(/https:\/\/vfm\.example\/alerts/);
    expect(
      emailText(
        message({
          kind: 'resolved',
          event: { ...message().event, resolvedAt: new Date('2026-10-17T03:00:00Z') },
        }),
      ),
    ).toMatch(/Ended: {3}2026-10-17T03:00:00.000Z/);
  });

  it('marks a test as one, in every format', () => {
    const t = message({ kind: 'test' });
    expect(subject(t)).toMatch(/TEST/);
    expect(emailText(t)).toMatch(/This is a test message/);
    expect(JSON.parse(slackBody(t)).text).toMatch(/Test message/);
    expect(JSON.parse(webhookBody(t))).toMatchObject({ kind: 'test', summary: 'Test message' });
  });

  it('puts log-derived text into Slack as text, not as markup', () => {
    const body = JSON.parse(
      slackBody(
        message({
          event: {
            ...message().event,
            payload: {
              ...message().event.payload,
              reason: '<!channel> <https://evil|click> & more',
            },
          },
        }),
      ),
    ) as { text: string };
    expect(body.text).not.toMatch(/<!channel>|<https/);
    expect(body.text).toMatch(/&lt;!channel&gt;/);
    expect(body.text).toMatch(/&amp; more/);
  });

  it('strips control characters and bounds what a payload can add', () => {
    const text = emailText(
      message({
        event: {
          ...message().event,
          payload: { ...message().event.payload, reason: `bad\u0000\u0007${'x'.repeat(2000)}` },
        },
      }),
    );
    expect(text).not.toMatch(/[\u0000\u0007]/);
    expect(text.length).toBeLessThan(900);
  });
});

describe('the webhook', () => {
  it('has a stable, versioned body', () => {
    const body = JSON.parse(webhookBody(message())) as Record<string, any>;
    expect(body).toMatchObject({
      version: 1,
      kind: 'fired',
      orgId: 'o1',
      rule: { id: 'r1', type: 'BACKUP_FAILED' },
      cluster: { id: 'c1', name: 'prod-eu' },
      event: {
        id: 'e1',
        state: 'FIRING',
        fingerprint: 'backup-failed:velero/nightly',
        resolvedAt: null,
      },
    });
    expect(body.summary).toMatch(/Backup nightly-1/);
    expect(
      JSON.parse(
        webhookBody(
          message({ kind: 'resolved', event: { ...message().event, resolvedAt: new Date() } }),
        ),
      ).event.state,
    ).toBe('RESOLVED');
  });

  it('signs timestamp and body with HMAC-SHA256, so a receiver can verify and refuse a replay', () => {
    const body = webhookBody(message());
    const now = new Date('2026-10-17T12:00:00Z');
    const headers = webhookHeaders('whsec_abc', message(), body, now);
    const ts = Math.floor(now.getTime() / 1000);
    expect(headers['x-vfm-timestamp']).toBe(ts.toString());
    expect(headers['x-vfm-signature']).toBe(
      `sha256=${createHmac('sha256', 'whsec_abc').update(`${ts.toString()}.${body}`).digest('hex')}`,
    );
    expect(headers['x-vfm-event-id']).toBe('e1');
    expect(headers['x-vfm-kind']).toBe('fired');
  });

  it('changes the signature with the secret, the time and the body', () => {
    const a = sign('s1', 1000, '{}');
    expect(sign('s2', 1000, '{}')).not.toBe(a);
    expect(sign('s1', 1001, '{}')).not.toBe(a);
    expect(sign('s1', 1000, '{ }')).not.toBe(a);
    expect(sign('s1', 1000, '{}')).toBe(a);
  });
});
