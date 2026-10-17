/**
 * A reader for the colour codes in container logs (SGR, ESC [ … m), nothing else.
 *
 * It produces plain data — text with a style — never markup, so a log line can not put
 * HTML or a link on the page. Every other escape sequence and every control character is
 * dropped. Colour and style start afresh on each line.
 */

export type Colour =
  | { kind: 'named'; index: number; bright: boolean }
  | { kind: 'rgb'; r: number; g: number; b: number };

export interface AnsiStyle {
  fg?: Colour;
  bg?: Colour;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Segment {
  text: string;
  style: AnsiStyle;
}

/* eslint-disable no-control-regex */
const ESCAPE =
  /\u001b(?:\[([0-9;:?<=>]*)([ -/]*)([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/* eslint-enable no-control-regex */

const clamp = (n: number): number => Math.min(255, Math.max(0, Math.trunc(n)));

/** The 256-colour palette: 16 named, a 6×6×6 cube, 24 greys. */
function palette(n: number): Colour {
  if (n < 8) return { kind: 'named', index: n, bright: false };
  if (n < 16) return { kind: 'named', index: n - 8, bright: true };
  if (n < 232) {
    const c = n - 16;
    const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return {
      kind: 'rgb',
      r: level(Math.floor(c / 36)),
      g: level(Math.floor(c / 6) % 6),
      b: level(c % 6),
    };
  }
  const grey = 8 + (n - 232) * 10;
  return { kind: 'rgb', r: grey, g: grey, b: grey };
}

function apply(style: AnsiStyle, codes: number[]): AnsiStyle {
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? 0;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code >= 30 && code <= 37) next.fg = { kind: 'named', index: code - 30, bright: false };
    else if (code >= 90 && code <= 97) next.fg = { kind: 'named', index: code - 90, bright: true };
    else if (code >= 40 && code <= 47) next.bg = { kind: 'named', index: code - 40, bright: false };
    else if (code >= 100 && code <= 107)
      next.bg = { kind: 'named', index: code - 100, bright: true };
    else if (code === 39) delete next.fg;
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg';
      const mode = codes[i + 1];
      if (mode === 5 && codes[i + 2] !== undefined) {
        next[target] = palette(clamp(codes[i + 2] ?? 0));
        i += 2;
      } else if (mode === 2 && codes[i + 4] !== undefined) {
        next[target] = {
          kind: 'rgb',
          r: clamp(codes[i + 2] ?? 0),
          g: clamp(codes[i + 3] ?? 0),
          b: clamp(codes[i + 4] ?? 0),
        };
        i += 4;
      } else {
        break;
      }
    }
  }
  return next;
}

/** Splits one line into styled pieces; text with no escape comes back as one piece. */
export function parseAnsi(line: string): Segment[] {
  if (!line.includes('\u001b')) {
    const text = line.replace(CONTROL, '');
    return text === '' ? [] : [{ text, style: {} }];
  }
  const out: Segment[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (raw: string): void => {
    const text = raw.replace(CONTROL, '');
    if (text !== '') out.push({ text, style });
  };
  for (const match of line.matchAll(ESCAPE)) {
    push(line.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[3] === 'm' && match[2] === '' && !/[?<=>]/.test(match[1] ?? '')) {
      const params = (match[1] ?? '') === '' ? [0] : (match[1] ?? '').split(/[;:]/).map(Number);
      style = apply(
        style,
        params.map((n) => (Number.isFinite(n) ? n : 0)),
      );
    }
  }
  push(line.slice(last));
  return out;
}

/** The line as it reads without colour: what search and download work on. */
export function stripAnsi(line: string): string {
  // One pass, no allocation per piece: this runs over every line of a buffer on each search.
  const bare = line.includes('\u001b') ? line.replace(ESCAPE, '') : line;
  return bare.replace(CONTROL, '');
}
