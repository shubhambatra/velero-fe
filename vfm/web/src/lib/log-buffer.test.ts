import { describe, expect, it } from 'vitest';

import { LineBuffer, MAX_LINE, MAX_LINES } from './log-buffer';

describe('LineBuffer', () => {
  it('holds a line back until its newline arrives', () => {
    const b = new LineBuffer();
    expect(b.push('hel')).toBe(0);
    expect(b.pending).toBe('hel');
    expect(b.lines).toEqual([]);
    expect(b.push('lo\nwor')).toBe(1);
    expect(b.lines).toEqual(['hello']);
    expect(b.pending).toBe('wor');
    b.push('ld\n');
    expect(b.lines).toEqual(['hello', 'world']);
    expect(b.pending).toBe('');
  });

  it('drops a carriage return before the newline and keeps empty lines', () => {
    const b = new LineBuffer();
    b.push('a\r\n\nb\n');
    expect(b.lines).toEqual(['a', '', 'b']);
  });

  it('keeps only the last lines and counts what fell off', () => {
    const b = new LineBuffer(3);
    b.push('1\n2\n3\n4\n5\n');
    expect(b.lines).toEqual(['3', '4', '5']);
    expect(b.dropped).toBe(2);
    expect(b.total).toBe(5);
    b.push('6\n');
    expect(b.lines).toEqual(['4', '5', '6']);
    expect(b.dropped).toBe(3);
  });

  it('keeps 50,000 lines by default', () => {
    const b = new LineBuffer();
    b.push(Array.from({ length: MAX_LINES + 10 }, (_, i) => String(i)).join('\n') + '\n');
    expect(b.lines).toHaveLength(MAX_LINES);
    expect(b.lines[0]).toBe('10');
    expect(b.dropped).toBe(10);
  });

  it('cuts a line that never ends, and one that is too long', () => {
    const b = new LineBuffer();
    b.push('x'.repeat(MAX_LINE * 2 + 5));
    expect(b.lines).toHaveLength(2);
    expect(b.pending).toHaveLength(5);
    b.push(`\n${'y'.repeat(MAX_LINE + 1)}\n`);
    expect(b.lines.every((l) => l.length <= MAX_LINE)).toBe(true);
  });

  it('does not change a snapshot taken earlier', () => {
    const b = new LineBuffer();
    b.push('a\n');
    const before = b.lines;
    b.push('b\n');
    expect(before).toEqual(['a']);
  });

  it('returns the text with the unfinished line, and clears', () => {
    const b = new LineBuffer();
    b.push('a\nb');
    expect(b.text()).toBe('a\nb\n');
    b.clear();
    expect(b.text()).toBe('');
    expect(b.total).toBe(0);
  });
});
