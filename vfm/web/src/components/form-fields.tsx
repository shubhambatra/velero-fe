import { useId, useState, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { inputClass } from '@/components/ui/field';
import { cn } from '@/lib/cn';

// ---------------------------------------------------------------------------
// Fields. Each has a real label, its hint and its error tied to the control.

interface FieldFrame {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
}

export function Frame({
  id,
  label,
  hint,
  error,
  children,
}: FieldFrame & { id: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: string, f: FieldFrame): string | undefined =>
  [f.hint !== undefined ? `${id}-hint` : '', f.error !== undefined ? `${id}-error` : '']
    .filter((s) => s !== '')
    .join(' ') || undefined;

export function Text(
  props: FieldFrame & {
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
    placeholder?: string;
    /** Names offered while typing; any value may still be entered. */
    suggestions?: string[];
  },
): ReactElement {
  const id = useId();
  return (
    <Frame id={id} {...props}>
      {props.suggestions !== undefined && (
        <datalist id={`${id}-options`}>
          {props.suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      <input
        list={props.suggestions === undefined ? undefined : `${id}-options`}
        id={id}
        className={cn(inputClass, props.error !== undefined && 'border-destructive')}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        aria-invalid={props.error !== undefined}
        aria-describedby={describedBy(id, props)}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
      />
    </Frame>
  );
}

export function Area(
  props: FieldFrame & {
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
    rows?: number;
    mono?: boolean;
    /** Shows dots instead of the text, for a secret. */
    masked?: boolean;
  },
): ReactElement {
  const id = useId();
  return (
    <Frame id={id} {...props}>
      <textarea
        id={id}
        rows={props.rows ?? 3}
        className={cn(
          inputClass,
          'h-auto py-2',
          props.mono === true && 'font-mono',
          props.masked === true && '[-webkit-text-security:disc]',
          props.error !== undefined && 'border-destructive',
        )}
        value={props.value}
        disabled={props.disabled}
        autoComplete="off"
        spellCheck={props.masked === true ? false : undefined}
        aria-invalid={props.error !== undefined}
        aria-describedby={describedBy(id, props)}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
      />
    </Frame>
  );
}

export function Select(
  props: FieldFrame & {
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
    disabled?: boolean;
  },
): ReactElement {
  const id = useId();
  return (
    <Frame id={id} {...props}>
      <select
        id={id}
        className={inputClass}
        value={props.value}
        disabled={props.disabled}
        aria-describedby={describedBy(id, props)}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Frame>
  );
}

export function CopyButton({ text }: { text: string }): ReactElement {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div>
      <Button
        variant="outline"
        onClick={() => {
          // Clipboard access can be refused (permissions, insecure origin): say so.
          const clipboard = (navigator as { clipboard?: Clipboard }).clipboard;
          if (clipboard === undefined) {
            setState('failed');
            return;
          }
          clipboard.writeText(text).then(
            () => {
              setState('copied');
            },
            () => {
              setState('failed');
            },
          );
        }}
      >
        Copy command
      </Button>
      <span role="status" className="ml-2 text-xs text-muted-foreground">
        {state === 'copied'
          ? 'Copied.'
          : state === 'failed'
            ? 'Could not copy; select the text instead.'
            : ''}
      </span>
    </div>
  );
}
