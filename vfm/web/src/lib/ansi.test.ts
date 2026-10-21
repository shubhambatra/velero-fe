import { describe, expect, it } from 'vitest';

import { parseAnsi, stripAnsi } from './ansi';

const ESC = '\u001b';

describe('parseAnsi', () => {
  it('returns plain text as one piece', () => {
    expect(parseAnsi('hello')).toEqual([{ text: 'hello', style: {} }]);
    expect(parseAnsi('')).toEqual([]);
  });

  it('reads colours and styles and resets them', () => {
    const out = parseAnsi(`${ESC}[1;31merror${ESC}[0m ok`);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      text: 'error',
      style: { bold: true, fg: { kind: 'named', index: 1, bright: false } },
    });
    expect(out[1]).toEqual({ text: ' ok', style: {} });
  });

  it('reads bright, background, 256-colour and true colour', () => {
    expect(parseAnsi(`${ESC}[92mx`)[0]?.style.fg).toEqual({
      kind: 'named',
      index: 2,
      bright: true,
    });
    expect(parseAnsi(`${ESC}[44mx`)[0]?.style.bg).toEqual({
      kind: 'named',
      index: 4,
      bright: false,
    });
    expect(parseAnsi(`${ESC}[38;5;196mx`)[0]?.style.fg).toEqual({
      kind: 'rgb',
      r: 255,
      g: 0,
      b: 0,
    });
    expect(parseAnsi(`${ESC}[38;2;1;2;3mx`)[0]?.style.fg).toEqual({
      kind: 'rgb',
      r: 1,
      g: 2,
      b: 3,
    });
    expect(parseAnsi(`${ESC}[38;2;999;0;3mx`)[0]?.style.fg).toEqual({
      kind: 'rgb',
      r: 255,
      g: 0,
      b: 3,
    });
  });

  it('treats a bare ESC[m as a reset', () => {
    expect(parseAnsi(`${ESC}[31ma${ESC}[mb`).map((s) => s.style)).toEqual([
      { fg: { kind: 'named', index: 1, bright: false } },
      {},
    ]);
  });

  it('drops other escape sequences and control characters', () => {
    expect(stripAnsi(`${ESC}[2Jclear${ESC}[K`)).toBe('clear');
    expect(stripAnsi(`${ESC}]0;title\u0007text`)).toBe('text');
    expect(stripAnsi(`a\u0000b\u0007c\u0008d`)).toBe('abcd');
    expect(stripAnsi(`${ESC}[?25lcursor`)).toBe('cursor');
  });

  it('keeps tabs, and never produces markup', () => {
    const out = parseAnsi(`${ESC}[31m<script>alert(1)</script>\tend`);
    expect(out[0]?.text).toBe('<script>alert(1)</script>\tend');
  });

  it('ignores a malformed code instead of throwing', () => {
    expect(stripAnsi(`${ESC}[38;5mtext${ESC}[;;;mmore`)).toBe('textmore');
  });
});
