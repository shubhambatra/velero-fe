import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState, type SyntheticEvent, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { useResetSession, useSession } from '@/lib/session';

export function MfaPage(): ReactElement {
  const session = useSession();
  if (session.status === 'loading') {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (session.status === 'anonymous') {
    return <Navigate to="/login" />;
  }
  if (session.status === 'ready') {
    return <Navigate to="/" />;
  }
  if (session.status === 'error') {
    return <ErrorNote message={errorMessage(session.error)} />;
  }
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">Two-step verification</h1>
      {session.reason === 'challenge' ? <Challenge /> : <Enrolment />}
    </div>
  );
}

function Challenge(): ReactElement {
  const navigate = useNavigate();
  const reset = useResetSession();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/auth/mfa/challenge', { method: 'POST', body: { code } });
      await reset();
      await navigate({ to: '/' });
    } catch (cause: unknown) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enter your code</CardTitle>
        <CardDescription>
          Use the six-digit code from your authenticator app, or one of your recovery codes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            void submit(e);
          }}
          className="flex flex-col gap-3"
        >
          <Field
            label="Code"
            autoComplete="one-time-code"
            inputMode="text"
            required
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
          />
          <ErrorNote message={error} />
          <Button type="submit" variant="primary" disabled={busy || code.trim().length < 6}>
            Verify
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Enrolment(): ReactElement {
  const navigate = useNavigate();
  const reset = useResetSession();
  const [secret, setSecret] = useState<{ secret: string; provisioningUri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCodes !== null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Save your recovery codes</CardTitle>
          <CardDescription>
            Each code works once if you lose your authenticator. They are shown only now.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 font-mono">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button
            variant="primary"
            onClick={() => {
              void (async () => {
                await reset();
                await navigate({ to: '/' });
              })();
            }}
          >
            I have saved these codes
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up an authenticator</CardTitle>
        <CardDescription>
          Your organization requires a second step when you sign in.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {secret === null ? (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              void run(async () => {
                setSecret(
                  await api<{ secret: string; provisioningUri: string }>('/auth/mfa/enrol', {
                    method: 'POST',
                  }),
                );
              });
            }}
          >
            Start setup
          </Button>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await api<{ recoveryCodes: string[] }>('/auth/mfa/enrol/confirm', {
                  method: 'POST',
                  body: { code },
                });
                setRecoveryCodes(result.recoveryCodes);
              });
            }}
          >
            <p>Add this key to your authenticator app:</p>
            <p className="break-all font-mono" data-testid="mfa-secret">
              {secret.secret}
            </p>
            <p className="text-xs text-muted-foreground">
              Or open this link on the device with your authenticator:{' '}
              <span className="break-all font-mono">{secret.provisioningUri}</span>
            </p>
            <Field
              label="Code from the app"
              autoComplete="one-time-code"
              inputMode="numeric"
              required
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
            <Button type="submit" variant="primary" disabled={busy || code.trim().length < 6}>
              Confirm
            </Button>
          </form>
        )}
        <ErrorNote message={error} />
      </CardContent>
    </Card>
  );
}
