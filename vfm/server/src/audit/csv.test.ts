import { describe, expect, it } from 'vitest';

import { csvCell, csvRow } from './csv';

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    [null, ''],
    [undefined, ''],
    [42, '42'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
  ])('%j -> %j', (input, output) => {
    expect(csvCell(input)).toBe(output);
  });

  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx'])('defuses the formula %j', (input) => {
    expect(csvCell(input).replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('serialises dates and objects', () => {
    expect(csvCell(new Date('2026-10-16T00:00:00Z'))).toBe('2026-10-16T00:00:00.000Z');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('ends a row with CRLF', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });
});
