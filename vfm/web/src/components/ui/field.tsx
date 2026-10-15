import { useId, type InputHTMLAttributes, type ReactElement, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

export const inputClass =
  'h-9 w-full rounded-md border border-control bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: ReactNode;
  hint?: ReactNode;
}

/** A labelled input; the label is always a real `<label>` bound by id. */
export function Field({ label, hint, className, id, ...props }: FieldProps): ReactElement {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <input id={inputId} className={cn(inputClass, className)} {...props} />
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** An inline error. `role="alert"` so it is announced when it appears. */
export function ErrorNote({ message }: { message: string | undefined }): ReactElement | null {
  if (message === undefined || message === '') {
    return null;
  }
  return (
    <p role="alert" className="text-sm font-medium text-destructive">
      {message}
    </p>
  );
}
