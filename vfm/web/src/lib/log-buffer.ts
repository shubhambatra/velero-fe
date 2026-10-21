/**
 * The viewer's memory of a live log: the last {@link MAX_LINES} complete lines (PLAN.md §7.3).
 *
 * Chunks arrive cut anywhere, including in the middle of a line, so the text after the last
 * newline is held back as a partial line until its newline arrives. A line with no newline
 * at all is cut at {@link MAX_LINE} characters so one runaway line cannot become one huge
 * element. Nothing here touches the DOM or React; the hook decides when to show a snapshot.
 */

export const MAX_LINES = 50_000;
export const MAX_LINE = 16_384;

export class LineBuffer {
  /** Complete lines, oldest first. Replaced, never mutated, so a snapshot stays valid. */
  private items: string[] = [];
  private partial = '';
  private droppedTotal = 0;
  private addedTotal = 0;

  constructor(private readonly max: number = MAX_LINES) {}

  /** Adds text; returns how many complete lines it made. */
  push(text: string): number {
    if (text === '') {
      return 0;
    }
    const parts = (this.partial + text).split('\n');
    this.partial = parts.pop() ?? '';
    const made: string[] = [];
    for (const part of parts) {
      this.cut(part.endsWith('\r') ? part.slice(0, -1) : part, made);
    }
    while (this.partial.length > MAX_LINE) {
      made.push(this.partial.slice(0, MAX_LINE));
      this.partial = this.partial.slice(MAX_LINE);
    }
    if (made.length === 0) {
      return 0;
    }
    this.addedTotal += made.length;
    const all = this.items.concat(made);
    const over = all.length - this.max;
    if (over > 0) {
      this.droppedTotal += over;
      this.items = all.slice(over);
    } else {
      this.items = all;
    }
    return made.length;
  }

  /** The last line, if it has not ended yet. Shown, but not counted. */
  get pending(): string {
    return this.partial;
  }

  /** Complete lines now held. */
  get lines(): readonly string[] {
    return this.items;
  }

  /** Lines that fell off the front since the start. */
  get dropped(): number {
    return this.droppedTotal;
  }

  /** Complete lines ever added (held or dropped). */
  get total(): number {
    return this.addedTotal;
  }

  /** Everything held, including a line that has not ended, as text. */
  text(): string {
    const lines = this.partial === '' ? this.items : [...this.items, this.partial];
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  clear(): void {
    this.items = [];
    this.partial = '';
    this.droppedTotal = 0;
    this.addedTotal = 0;
  }

  private cut(line: string, into: string[]): void {
    if (line.length <= MAX_LINE) {
      into.push(line);
      return;
    }
    for (let i = 0; i < line.length; i += MAX_LINE) {
      into.push(line.slice(i, i + MAX_LINE));
    }
  }
}
