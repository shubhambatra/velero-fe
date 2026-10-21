import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { inputClass } from '@/components/ui/field';
import { parseAnsi, stripAnsi, type AnsiStyle, type Colour } from '@/lib/ansi';
import { MAX_LINES } from '@/lib/log-buffer';
import type { Snapshot } from '@/lib/log-session';
import { cn } from '@/lib/cn';

/** Full class names, so Tailwind sees every one of them. */
const FG = [
  'text-neutral-500',
  'text-red-600 dark:text-red-400',
  'text-green-700 dark:text-green-400',
  'text-yellow-700 dark:text-yellow-300',
  'text-blue-600 dark:text-blue-400',
  'text-fuchsia-600 dark:text-fuchsia-400',
  'text-cyan-700 dark:text-cyan-400',
  'text-neutral-700 dark:text-neutral-200',
];
const FG_BRIGHT = [
  'text-neutral-600 dark:text-neutral-400',
  'text-red-500 dark:text-red-300',
  'text-green-600 dark:text-green-300',
  'text-yellow-600 dark:text-yellow-200',
  'text-blue-500 dark:text-blue-300',
  'text-fuchsia-500 dark:text-fuchsia-300',
  'text-cyan-600 dark:text-cyan-300',
  'text-neutral-900 dark:text-white',
];
const BG = [
  'bg-neutral-500/30',
  'bg-red-500/30',
  'bg-green-500/30',
  'bg-yellow-500/30',
  'bg-blue-500/30',
  'bg-fuchsia-500/30',
  'bg-cyan-500/30',
  'bg-neutral-500/20',
];

const rgb = (c: Extract<Colour, { kind: 'rgb' }>): string =>
  `rgb(${c.r.toString()} ${c.g.toString()} ${c.b.toString()})`;

function styleOf(style: AnsiStyle): { className: string; css: CSSProperties } {
  const css: CSSProperties = {};
  const classes: string[] = [];
  const swap = style.inverse === true;
  const fg = swap ? style.bg : style.fg;
  const bg = swap ? style.fg : style.bg;
  if (fg?.kind === 'named') classes.push((fg.bright ? FG_BRIGHT : FG)[fg.index] ?? '');
  else if (fg !== undefined) css.color = rgb(fg);
  if (bg?.kind === 'named') classes.push(BG[bg.index] ?? '');
  else if (bg !== undefined) css.backgroundColor = rgb(bg);
  if (style.bold === true) classes.push('font-bold');
  if (style.dim === true) classes.push('opacity-70');
  if (style.italic === true) classes.push('italic');
  if (style.underline === true) classes.push('underline');
  return { className: classes.join(' '), css };
}

const Line = memo(function Line({ text }: { text: string }): ReactElement {
  const segments = parseAnsi(text);
  if (segments.length === 0) {
    // An empty line still has a height.
    return <>{'​'}</>;
  }
  return (
    <>
      {segments.map((segment, i) => {
        const { className, css } = styleOf(segment.style);
        return className === '' && Object.keys(css).length === 0 ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <span key={i} className={className} style={css}>
            {segment.text}
          </span>
        );
      })}
    </>
  );
});

interface Props {
  snapshot: Snapshot;
  /** Whether new lines are still arriving; decides what "Follow" and "Pause" offer. */
  live: boolean;
  /** The buffer as text for the download, and the name to save it under. */
  text: () => string;
  fileName: string;
  onClear?: () => void;
  /** Shown when there is nothing to show yet. */
  emptyHint?: string;
}

/**
 * A log you can leave running (PLAN.md §7.3, §11): the last 50,000 lines in a virtualized
 * list, so a long log costs the same to show as a short one.
 *
 * Follow keeps the newest line in view and turns itself off when you scroll up. Pause
 * freezes what is shown while lines keep arriving behind it. Search looks through the
 * whole buffer. Colours are read from the log's own codes and never become markup.
 */
export function LogViewer({
  snapshot,
  live,
  text,
  fileName,
  onClear,
  emptyHint,
}: Props): ReactElement {
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const [frozen, setFrozen] = useState<Snapshot | null>(null);

  const shown = paused && frozen !== null ? frozen : snapshot;
  const rows = useMemo(
    () => (shown.pending === '' ? shown.lines : [...shown.lines, shown.pending]),
    [shown],
  );
  const behind = paused && frozen !== null ? snapshot.total - frozen.total : 0;

  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (needle === '') return [];
    const found: number[] = [];
    rows.forEach((line, i) => {
      if (stripAnsi(line).toLowerCase().includes(needle)) {
        found.push(i);
      }
    });
    return found;
  }, [rows, needle]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const active = matches.length === 0 ? -1 : Math.min(current, matches.length - 1);

  const scroller = useRef<HTMLDivElement>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 22,
    overscan: 20,
    // Until the browser reports the real size.
    initialRect: { width: 800, height: 480 },
  });

  /**
   * Scrolls to a row, then once more after the rows on the way have been measured: rows
   * not seen yet are estimated, so the first jump can land a little off.
   */
  const jumpTo = (index: number): void => {
    virtual.scrollToIndex(index, { align: 'center' });
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      virtual.scrollToIndex(index, { align: 'center' });
    }, 120);
  };
  useEffect(
    () => () => {
      if (settle.current !== null) clearTimeout(settle.current);
    },
    [],
  );

  // A new search takes you to its first match.
  const firstMatch = matches[0];
  useEffect(() => {
    if (needle !== '' && firstMatch !== undefined) {
      setFollow(false);
      jumpTo(firstMatch);
    }
    // Only a change of search moves the view; new lines matching it must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle]);

  // Follow: stay on the newest line while lines arrive.
  useEffect(() => {
    if (follow && !paused && rows.length > 0) {
      virtual.scrollToIndex(rows.length - 1, { align: 'end' });
    }
  }, [follow, paused, rows.length, virtual]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (el !== null && follow && el.scrollHeight - el.scrollTop - el.clientHeight > 48) {
      setFollow(false);
    }
  };

  const go = (to: number): void => {
    if (matches.length === 0) return;
    const next = (to + matches.length) % matches.length;
    setCurrent(next);
    setFollow(false);
    jumpTo(matches[next] ?? 0);
  };

  const togglePause = (): void => {
    if (paused) {
      setPaused(false);
      setFrozen(null);
    } else {
      setFrozen(snapshot);
      setPaused(true);
      setFollow(false);
    }
  };

  const download = (): void => {
    const url = URL.createObjectURL(
      new Blob([text().split('\n').map(stripAnsi).join('\n')], { type: 'text/plain' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-2">
      <div role="toolbar" aria-label="Log controls" className="flex flex-wrap items-end gap-2">
        <Button
          variant={follow ? 'primary' : 'outline'}
          aria-pressed={follow}
          disabled={paused}
          onClick={() => {
            setFollow((f) => !f);
          }}
        >
          Follow
        </Button>
        <Button
          variant={paused ? 'primary' : 'outline'}
          aria-pressed={paused}
          onClick={togglePause}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant={wrap ? 'primary' : 'outline'}
          aria-pressed={wrap}
          onClick={() => {
            setWrap((w) => !w);
          }}
        >
          Wrap lines
        </Button>
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">Search the buffer</span>
          <input
            className={cn(inputClass, 'w-56')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCurrent(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go(active + (e.shiftKey ? -1 : 1));
            }}
          />
        </label>
        {needle !== '' && (
          <span className="flex items-center gap-1 pb-1 text-sm" role="status">
            <span className="text-muted-foreground">
              {matches.length === 0
                ? 'No match'
                : `${(active + 1).toString()} of ${matches.length.toString()}`}
            </span>
            <Button
              variant="outline"
              aria-label="Previous match"
              disabled={matches.length === 0}
              onClick={() => {
                go(active - 1);
              }}
            >
              ↑
            </Button>
            <Button
              variant="outline"
              aria-label="Next match"
              disabled={matches.length === 0}
              onClick={() => {
                go(active + 1);
              }}
            >
              ↓
            </Button>
          </span>
        )}
        <Button
          variant="outline"
          onClick={download}
          disabled={snapshot.total === 0 && snapshot.pending === ''}
        >
          Download
        </Button>
        {onClear !== undefined && (
          <Button variant="outline" onClick={onClear} disabled={snapshot.total === 0}>
            Clear
          </Button>
        )}
        <span className="flex gap-2 pb-2 text-sm text-muted-foreground">
          <span>{`${shown.lines.length.toString()} lines`}</span>
          {live && !paused && <Badge tone="ok">live</Badge>}
          {paused && <Badge tone="warn">{`paused · ${behind.toString()} new`}</Badge>}
        </span>
      </div>
      {snapshot.dropped > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {`The oldest ${snapshot.dropped.toLocaleString()} lines were dropped; the viewer keeps the last ${MAX_LINES.toLocaleString()}. Download to keep what is shown.`}
        </p>
      )}
      <div
        ref={scroller}
        role="log"
        aria-label="Log output"
        tabIndex={0}
        onScroll={onScroll}
        className="h-[32rem] overflow-auto rounded-md border border-control bg-card font-mono text-xs"
      >
        {rows.length === 0 ? (
          <p className="p-3 text-muted-foreground">{emptyHint ?? 'Nothing yet.'}</p>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: 'relative', minWidth: '100%' }}>
            {virtual.getVirtualItems().map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtual.measureElement}
                className={cn(
                  'absolute left-0 top-0 min-w-full px-3 py-px leading-5',
                  wrap ? 'w-full whitespace-pre-wrap break-all' : 'w-max whitespace-pre',
                  matchSet.has(item.index) && 'bg-yellow-200/40 dark:bg-yellow-500/20',
                  item.index === matches[active] && 'outline outline-1 outline-ring',
                )}
                style={{ transform: `translateY(${item.start.toString()}px)` }}
              >
                <Line text={rows[item.index] ?? ''} />
              </div>
            ))}
          </div>
        )}
      </div>
      {!follow && !paused && rows.length > 0 && live && (
        <Button
          variant="outline"
          onClick={() => {
            setFollow(true);
          }}
        >
          Jump to the newest line
        </Button>
      )}
    </div>
  );
}
