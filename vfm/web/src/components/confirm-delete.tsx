import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorNote, inputClass } from '@/components/ui/field';

/**
 * A destructive action's confirmation (PLAN.md §11.2): the name of the thing has to
 * be typed before the button works. Re-authentication is not asked for here — the
 * request that follows goes through `api()`, which opens the sudo dialog when the
 * server says it is needed and repeats the request.
 */
export function ConfirmDelete({
  name,
  title,
  consequence,
  confirmLabel,
  busyLabel = 'Deleting…',
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  name: string;
  title: string;
  consequence: ReactNode;
  confirmLabel: string;
  /** Shown on the button while the request is in flight. */
  busyLabel?: string;
  busy: boolean;
  error: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const [typed, setTyped] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();

  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  const matches = typed === name;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        className="w-full max-w-md rounded-lg border border-border bg-card p-4 text-card-foreground"
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !busy) {
              onConfirm();
            }
          }}
        >
          <h2 id="confirm-delete-title" className="text-base font-semibold">
            {title}
          </h2>
          <p className="text-sm">{consequence}</p>
          <label htmlFor={inputId} className="text-sm font-medium">
            {`Type ${name} to confirm`}
          </label>
          <input
            id={inputId}
            ref={input}
            className={inputClass}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setTyped(e.target.value);
            }}
          />
          <ErrorNote message={error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || busy}>
              {busy ? busyLabel : confirmLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
