import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { LogChunk } from '../gateway/pb/vfm/agent/v1/logs';
import { DownloadAssembler, MAX_CHUNK_BYTES } from './download-assembler';

const chunk = (sequence: number, text: string, eof = false): LogChunk => ({
  commandId: 'c1',
  sequence,
  data: Buffer.from(text),
  eof,
});
const sum = (text: string) => ({
  bytesSent: Buffer.byteLength(text),
  sha256Hex: createHash('sha256').update(text).digest('hex'),
});

function started(limit = 1024, now?: () => number) {
  const a = new DownloadAssembler(now);
  expect(a.start('c1', 'cluster-a', limit)).toBeUndefined();
  return a;
}

describe('DownloadAssembler', () => {
  it('puts chunks back together and checks them against the summary', () => {
    const a = started();
    a.add('c1', chunk(0, 'hello '));
    a.add('c1', chunk(1, 'world'));
    a.add('c1', chunk(2, '', true));
    const done = a.finish('c1', sum('hello world'));
    expect(done).toEqual({ ok: true, data: Buffer.from('hello world') });
    expect(a.has('c1')).toBe(false);
  });

  it('accepts an empty file', () => {
    const a = started();
    a.add('c1', chunk(0, '', true));
    expect(a.finish('c1', sum(''))).toEqual({ ok: true, data: Buffer.alloc(0) });
  });

  it.each([
    ['a gap', [chunk(0, 'a'), chunk(2, 'b', true)]],
    ['a repeat', [chunk(0, 'a'), chunk(0, 'a', true)]],
    ['data after the end marker', [chunk(0, 'a', true), chunk(1, 'b', true)]],
  ])('fails on %s', (_name, chunks) => {
    const a = started();
    for (const c of chunks) {
      a.add('c1', c);
    }
    expect(a.finish('c1', sum('ab')).ok).toBe(false);
  });

  it('fails when the end never arrives', () => {
    const a = started();
    a.add('c1', chunk(0, 'abc'));
    expect(a.finish('c1', sum('abc'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('end marker'),
    });
  });

  it('fails when the size or the checksum differs from what the agent said', () => {
    const a = started();
    a.add('c1', chunk(0, 'abc', true));
    expect(a.finish('c1', { ...sum('abc'), bytesSent: 4 }).ok).toBe(false);

    const b = started();
    b.add('c1', chunk(0, 'abc', true));
    expect(b.finish('c1', sum('abd')).ok).toBe(false);
  });

  it('stops at the size limit and at the chunk size limit', () => {
    const a = started(10);
    a.add('c1', chunk(0, '123456'));
    a.add('c1', chunk(1, '78901', true));
    expect(a.finish('c1', sum('12345678901'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('limit'),
    });

    const b = started(10 * MAX_CHUNK_BYTES);
    b.add('c1', chunk(0, 'x'.repeat(MAX_CHUNK_BYTES + 1), true));
    expect(b.finish('c1', sum('x'.repeat(MAX_CHUNK_BYTES + 1))).ok).toBe(false);
  });

  it('ignores chunks of a download it was never told to expect', () => {
    const a = new DownloadAssembler();
    a.add('c1', chunk(0, 'x', true));
    expect(a.has('c1')).toBe(false);
    expect(a.finish('c1', sum('x')).ok).toBe(false);
  });

  it('starts over when the agent retries from sequence zero', () => {
    const a = started();
    a.add('c1', chunk(0, 'old'));
    expect(a.start('c1', 'cluster-a', 1024)).toBeUndefined();
    a.add('c1', chunk(0, 'new', true));
    expect(a.finish('c1', sum('new'))).toEqual({ ok: true, data: Buffer.from('new') });
  });

  it('allows a few downloads per cluster, not unlimited', () => {
    const a = new DownloadAssembler();
    for (const id of ['1', '2', '3', '4']) {
      expect(a.start(id, 'cluster-a', 10)).toBeUndefined();
    }
    expect(a.start('5', 'cluster-a', 10)).toMatch(/too many/);
    expect(a.start('5', 'cluster-b', 10)).toBeUndefined();
    a.drop('1');
    expect(a.start('6', 'cluster-a', 10)).toBeUndefined();
  });

  it('forgets a download nothing has touched for a while', () => {
    let now = 1_000;
    const a = started(1024, () => now);
    a.add('c1', chunk(0, 'a'));
    now += 60_000;
    expect(a.expire()).toBe(0);
    now += 61_000;
    expect(a.expire()).toBe(1);
    expect(a.has('c1')).toBe(false);
  });

  it('gives memory back when a download is dropped or fails', () => {
    // 256 MiB total across the replica: fill most of it with downloads that break, then succeed.
    const a = new DownloadAssembler();
    for (let i = 0; i < 4; i += 1) {
      a.start(`c${i.toString()}`, `cl${i.toString()}`, 64 * 1024 * 1024);
      for (let s = 0; s < 1024; s += 1) {
        a.add(`c${i.toString()}`, {
          commandId: `c${i.toString()}`,
          sequence: s,
          data: Buffer.alloc(MAX_CHUNK_BYTES),
          eof: false,
        });
      }
    }
    a.start('late', 'cl9', 1024);
    a.add('late', { commandId: 'late', sequence: 0, data: Buffer.from('x'), eof: true });
    expect(a.finish('late', sum('x')).ok).toBe(false); // the replica is full
    a.drop('c0');
    a.start('late', 'cl9', 1024);
    a.add('late', { commandId: 'late', sequence: 0, data: Buffer.from('x'), eof: true });
    expect(a.finish('late', sum('x')).ok).toBe(true);
  });
});
