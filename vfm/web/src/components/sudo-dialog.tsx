import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
  type ReactElement,
} from 'react';

import { Button } from '@/components/ui/button';
import { ErrorNote, Field } from '@/components/ui/field';
import { api, errorMessage, registerSudoPrompt } from '@/lib/client';

export interface SudoDialogProps {
  onDone: (ok: boolean) => void;
}

/** Asks for the account password and opens the sudo window (POST /auth/sudo). */
export function SudoDialog({ onDone }: SudoDialogProps): ReactElement {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/auth/sudo', { method: 'POST', body: { password } });
      onDone(true);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sudo-title"
        className="w-full max-w-sm rounded-lg border border-border bg-card p-4 text-card-foreground"
      >
        <form
          onSubmit={(e) => {
            void submit(e);
          }}
          className="flex flex-col gap-3"
        >
          <h2 id="sudo-title" className="text-base font-semibold">
            Confirm your password
          </h2>
          <p className="text-sm text-muted-foreground">
            This action needs a recent sign-in. Enter your password to continue.
          </p>
          <Field
            label="Password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
          <ErrorNote message={error} />
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                onDone(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || password === ''}>
              Confirm
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Mounts the dialog on demand and registers it with the API client. */
export function SudoProvider({ children }: { children: React.ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  const pending = useRef<Promise<boolean> | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const prompt = useCallback((): Promise<boolean> => {
    // Several requests can fail at once; they share one dialog.
    if (pending.current !== null) {
      return pending.current;
    }
    pending.current = new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
    setOpen(true);
    return pending.current;
  }, []);

  useEffect(() => registerSudoPrompt(prompt), [prompt]);

  const finish = (ok: boolean): void => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
    pending.current = null;
  };

  return (
    <>
      {children}
      {open && <SudoDialog onDone={finish} />}
    </>
  );
}
