import { useMemo, useState, type ReactElement } from 'react';

import { Time } from '@/components/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, inputClass } from '@/components/ui/field';
import { downloadHref, useFile, type FileKind, type FilePart } from '@/lib/files';
import { cn } from '@/lib/cn';

const PAGE = 500;

interface PanelProps {
  orgId: string;
  clusterId: string;
  kind: FileKind;
  name: string;
  part: FilePart;
  title: string;
  description: string;
  /** How the fetched text is shown. */
  view?: 'log' | 'json' | 'resources';
}

/**
 * One of Velero's files for a backup or restore, with the states it passes through:
 * nothing saved yet, being fetched by the agent, failed, and ready. Nothing is fetched
 * until someone asks — a log can be large and reading it is an audited act.
 */
export function FilePanel(props: PanelProps): ReactElement {
  const { orgId, clusterId, kind, name, part, title, description, view = 'json' } = props;
  const file = useFile(orgId, clusterId, kind, name, part);
  const { state } = file;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.phase === 'loading' && (
          <p role="status" className="text-sm text-muted-foreground">
            Looking for a saved copy…
          </p>
        )}
        {state.phase === 'forbidden' && (
          <p role="alert" className="text-sm">
            You do not have permission to read this. {state.message}
          </p>
        )}
        {state.phase === 'error' && <ErrorNote message={state.message} />}
        {state.phase === 'empty' && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              No saved copy yet. The agent reads it from the cluster when you ask.
            </p>
            <Button
              onClick={() => {
                file.fetch(false);
              }}
              disabled={file.busy}
            >
              Fetch from the cluster
            </Button>
          </div>
        )}
        {state.phase === 'fetching' && (
          <p role="status" className="text-sm text-muted-foreground">
            {`Asking the agent for it… (${state.status.toLowerCase()})`}
          </p>
        )}
        {state.phase === 'failed' && (
          <div className="space-y-2">
            <ErrorNote message={state.message} />
            <Button
              onClick={() => {
                file.fetch(true);
              }}
              disabled={file.busy}
            >
              Try again
            </Button>
          </div>
        )}
        {state.phase === 'ready' && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span>
                Fetched <Time value={state.fetchedAt} />
              </span>
              <span>
                Kept until <Time value={state.expiresAt} />
              </span>
              <Button
                variant="outline"
                onClick={() => {
                  file.fetch(true);
                }}
                disabled={file.busy}
              >
                Refresh from the cluster
              </Button>
              <a className="underline" href={downloadHref(file.path)} download>
                Download
              </a>
            </div>
            {view === 'log' ? (
              <LogView text={state.text} />
            ) : view === 'resources' ? (
              <ResourceListView text={state.text} />
            ) : (
              <JsonView text={state.text} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const LEVELS = ['all', 'error', 'warning', 'info', 'debug'] as const;
type Level = (typeof LEVELS)[number];

const levelOf = (line: string): Level | 'other' => {
  const match = /\blevel=("?)(\w+)\1/.exec(line);
  const level = match?.[2]?.toLowerCase();
  if (level === 'error' || level === 'fatal' || level === 'panic') {
    return 'error';
  }
  if (level === 'warning' || level === 'warn') {
    return 'warning';
  }
  return level === 'info' || level === 'debug' ? level : 'other';
};

/** A log: filterable by level and text, shown a page of lines at a time. */
export function LogView({ text }: { text: string }): ReactElement {
  const [level, setLevel] = useState<Level>('all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);

  const lines = useMemo(
    () => text.split('\n').filter((l, i, all) => l !== '' || i < all.length - 1),
    [text],
  );
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lines.filter(
      (line) =>
        (level === 'all' || levelOf(line) === level) &&
        (needle === '' || line.toLowerCase().includes(needle)),
    );
  }, [lines, level, query]);
  const errors = useMemo(() => lines.filter((l) => levelOf(l) === 'error').length, [lines]);
  const warnings = useMemo(() => lines.filter((l) => levelOf(l) === 'warning').length, [lines]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">Search the log</span>
          <input
            className={inputClass}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">Level</span>
          <select
            className={inputClass}
            value={level}
            onChange={(e) => {
              setLevel(e.target.value as Level);
              setShown(PAGE);
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2 pb-2 text-sm">
          <Badge tone={errors > 0 ? 'error' : 'neutral'}>{`${errors.toString()} errors`}</Badge>
          <Badge
            tone={warnings > 0 ? 'warn' : 'neutral'}
          >{`${warnings.toString()} warnings`}</Badge>
          <span className="text-muted-foreground">{`${lines.length.toString()} lines`}</span>
        </div>
      </div>
      {matching.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {lines.length === 0 ? 'The log is empty.' : 'No line matches these filters.'}
        </p>
      ) : (
        <pre
          aria-label="Log"
          className="max-h-[32rem] overflow-auto rounded-md border border-control bg-card p-3 text-xs"
        >
          {matching.slice(0, shown).map((line, i) => {
            const l = levelOf(line);
            return (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-all',
                  l === 'error' && 'text-red-600 dark:text-red-400',
                  l === 'warning' && 'text-amber-600 dark:text-amber-400',
                )}
              >
                {line}
              </div>
            );
          })}
        </pre>
      )}
      {matching.length > shown && (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            {`Showing ${shown.toString()} of ${matching.length.toString()} lines`}
          </span>
          <Button
            variant="outline"
            onClick={() => {
              setShown((n) => n + PAGE);
            }}
          >
            Show more
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setShown(matching.length);
            }}
          >
            Show all
          </Button>
        </div>
      )}
    </div>
  );
}

function pretty(text: string): { ok: true; value: unknown; text: string } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value, text: JSON.stringify(value, null, 2) };
  } catch {
    return { ok: false };
  }
}

/** A JSON file, indented; anything that does not parse is shown as it arrived. */
export function JsonView({ text }: { text: string }): ReactElement {
  const parsed = useMemo(() => pretty(text), [text]);
  const body = parsed.ok ? parsed.text : text;
  const lines = body.split('\n');
  const [shown, setShown] = useState(PAGE * 2);
  if (
    body.trim() === '' ||
    (parsed.ok &&
      (parsed.value === null ||
        JSON.stringify(parsed.value) === '{}' ||
        JSON.stringify(parsed.value) === '[]'))
  ) {
    return <p className="text-sm text-muted-foreground">Velero recorded nothing here.</p>;
  }
  return (
    <div className="space-y-2">
      <pre
        aria-label="File contents"
        className="max-h-[32rem] overflow-auto rounded-md border border-control bg-card p-3 text-xs"
      >
        {lines.slice(0, shown).join('\n')}
      </pre>
      {lines.length > shown && (
        <Button
          variant="outline"
          onClick={() => {
            setShown(lines.length);
          }}
        >
          {`Show all ${lines.length.toString()} lines`}
        </Button>
      )}
    </div>
  );
}

/** Velero's resource list: `{ "v1/Pod": ["ns/name", ...] }`, grouped by kind. */
export function ResourceListView({ text }: { text: string }): ReactElement {
  const parsed = useMemo(() => pretty(text), [text]);
  if (
    !parsed.ok ||
    typeof parsed.value !== 'object' ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  ) {
    return <JsonView text={text} />;
  }
  const groups = Object.entries(parsed.value as Record<string, unknown>)
    .map(([kind, items]) => [kind, Array.isArray(items) ? items.map(String) : []] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">Velero recorded nothing here.</p>;
  }
  const total = groups.reduce((sum, [, items]) => sum + items.length, 0);
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">{`${total.toString()} items in ${groups.length.toString()} kinds`}</p>
      {groups.map(([kind, items]) => (
        <details key={kind} className="rounded-md border border-control p-2">
          <summary className="cursor-pointer">
            <span className="font-mono">{kind}</span>
            <span className="ml-2 text-muted-foreground">{items.length.toString()}</span>
          </summary>
          <ul className="mt-2 max-h-64 overflow-auto font-mono text-xs">
            {items.slice(0, 1000).map((item) => (
              <li key={item}>{item}</li>
            ))}
            {items.length > 1000 && <li>{`… and ${(items.length - 1000).toString()} more`}</li>}
          </ul>
        </details>
      ))}
    </div>
  );
}
