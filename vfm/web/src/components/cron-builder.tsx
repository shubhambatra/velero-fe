import { useMemo, useState, type ReactElement } from 'react';

import { Select, Text } from '@/components/form-fields';
import {
  DEFAULT_PATTERN,
  expressionFor,
  nextRuns,
  parseCron,
  patternOf,
  type Frequency,
  type Pattern,
} from '@/lib/cron';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'custom', label: 'Custom expression' },
];

const range = (from: number, to: number): { value: string; label: string }[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    value: (from + i).toString(),
    label: (from + i).toString().padStart(2, '0'),
  }));

/** The viewer's time zone, for the label above the list of runs. */
const zone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'local time';
  }
};

/**
 * Picks a schedule's cron expression and shows when it will next run (PLAN.md §11.1).
 * The expression is always visible and editable; the pickers write it, and typing a
 * pattern the pickers know moves them to match.
 *
 * Velero reads the expression in the time zone of its own process, normally UTC, so the
 * hour is a UTC hour. The runs are listed in both UTC and the viewer's own zone.
 */
export function CronBuilder({
  value,
  onChange,
  error,
  now,
}: {
  value: string;
  onChange: (expression: string) => void;
  error?: string | undefined;
  /** For tests. */
  now?: Date;
}): ReactElement {
  const [pattern, setPattern] = useState<Pattern>(() => patternOf(value));

  const apply = (next: Pattern) => {
    setPattern(next);
    if (next.frequency !== 'custom') onChange(expressionFor(next));
  };
  const change = (patch: Partial<Pattern>) => {
    apply({ ...pattern, ...patch });
  };

  const parsed = parseCron(value);
  const runs = useMemo(
    () => ('cron' in parsed ? nextRuns(parsed.cron, now ?? new Date(), 5) : []),
    // `parsed` is rebuilt every render; the expression is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, now],
  );
  const showHour = pattern.frequency !== 'hourly' && pattern.frequency !== 'custom';

  return (
    <div className="flex flex-col gap-3">
      <Select
        label="Repeat"
        value={pattern.frequency}
        onChange={(v) => {
          const frequency = v as Frequency;
          if (frequency === 'custom') setPattern({ ...pattern, frequency });
          else
            apply({ ...(pattern.frequency === 'custom' ? DEFAULT_PATTERN : pattern), frequency });
        }}
        options={FREQUENCIES}
      />
      {pattern.frequency !== 'custom' && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {pattern.frequency === 'weekly' && (
            <Select
              label="On"
              value={pattern.weekday.toString()}
              onChange={(v) => {
                change({ weekday: Number(v) });
              }}
              options={WEEKDAYS.map((label, i) => ({ value: i.toString(), label }))}
            />
          )}
          {pattern.frequency === 'monthly' && (
            <Select
              label="On day"
              hint="Months without this day are skipped."
              value={pattern.dayOfMonth.toString()}
              onChange={(v) => {
                change({ dayOfMonth: Number(v) });
              }}
              options={range(1, 31)}
            />
          )}
          {showHour && (
            <Select
              label="Hour (UTC)"
              value={pattern.hour.toString()}
              onChange={(v) => {
                change({ hour: Number(v) });
              }}
              options={range(0, 23)}
            />
          )}
          <Select
            label={pattern.frequency === 'hourly' ? 'At minute' : 'Minute'}
            value={pattern.minute.toString()}
            onChange={(v) => {
              change({ minute: Number(v) });
            }}
            options={range(0, 59)}
          />
        </div>
      )}
      <Text
        label="Cron expression"
        hint="Five fields: minute hour day-of-month month day-of-week. Also @daily, @hourly… and @every 6h."
        error={error}
        value={value}
        onChange={(text) => {
          setPattern(patternOf(text));
          onChange(text);
        }}
      />
      <div aria-label="Next runs">
        <p className="text-sm font-medium">{`Next runs (${zone()})`}</p>
        {'cron' in parsed && runs.length > 0 ? (
          <ol className="mt-1 flex flex-col gap-0.5 text-sm">
            {runs.map((at) => (
              <li key={at.toISOString()} className="flex flex-wrap gap-x-3">
                <time dateTime={at.toISOString()}>
                  {at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </time>
                <span className="text-muted-foreground">
                  {`${at.toISOString().replace('T', ' ').slice(0, 16)} UTC`}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            {'cron' in parsed
              ? 'This expression never matches a real date.'
              : 'Fix the expression to see when it runs.'}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Velero reads schedules in its own time zone, normally UTC.
          {'cron' in parsed && parsed.cron.kind === 'every'
            ? ' With “@every”, runs are counted from the last one, so these times are only approximate.'
            : ''}
        </p>
      </div>
    </div>
  );
}
