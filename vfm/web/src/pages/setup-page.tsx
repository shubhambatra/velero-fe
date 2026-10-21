import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type SyntheticEvent, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorNote, Field } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { useResetSession } from '@/lib/session';

/** First-run: creates the platform administrator with the token from the server log. */
export function SetupPage(): ReactElement {
  const navigate = useNavigate();
  const reset = useResetSession();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const status = useQuery({
    queryKey: ['setup'],
    queryFn: ({ signal }) => api<{ open: boolean }>('/auth/setup', { signal }),
  });

  const setup = useMutation({
    mutationFn: () => api('/auth/setup', { method: 'POST', body: { token, email, password } }),
    onSuccess: async () => {
      await reset();
      await navigate({ to: '/' });
    },
  });

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    setup.mutate();
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">First-time setup</h1>
      {status.data?.open === false ? (
        <p className="text-sm text-muted-foreground">Setup is already complete. Sign in instead.</p>
      ) : (
        <Card>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Field
                label="Setup token"
                hint="Printed in the control plane log on first start."
                autoComplete="off"
                required
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                }}
              />
              <Field
                label="Administrator email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
              />
              <Field
                label="Password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
              />
              <ErrorNote message={setup.isError ? errorMessage(setup.error) : undefined} />
              <Button type="submit" variant="primary" disabled={setup.isPending}>
                Create administrator
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
