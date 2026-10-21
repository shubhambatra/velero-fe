import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type SyntheticEvent, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field } from '@/components/ui/field';
import { API_BASE_URL } from '@/lib/api';
import { api, errorMessage } from '@/lib/client';
import { useResetSession } from '@/lib/session';
import type { MfaPendingReason, User } from '@/lib/types';

interface LoginResult {
  user: User;
  mfaPendingReason: MfaPendingReason | null;
}

export function LoginPage({ ssoFailed = false }: { ssoFailed?: boolean }): ReactElement {
  const navigate = useNavigate();
  const reset = useResetSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [providers, setProviders] = useState<{ id: string; name: string }[] | null>(null);
  const [ssoError, setSsoError] = useState<string | undefined>();

  const login = useMutation({
    mutationFn: () =>
      api<LoginResult>('/auth/login', { method: 'POST', body: { email, password } }),
    onSuccess: async (result) => {
      await reset();
      await navigate({ to: result.mfaPendingReason === null ? '/' : '/mfa' });
    },
  });

  const findSso = async (): Promise<void> => {
    setSsoError(undefined);
    const slug = orgSlug.trim().toLowerCase();
    if (slug === '') {
      return;
    }
    try {
      const result = await api<{ providers: { id: string; name: string }[] }>(
        `/auth/oidc/providers?org=${encodeURIComponent(slug)}`,
      );
      setProviders(result.providers);
    } catch (error: unknown) {
      setProviders(null);
      setSsoError(errorMessage(error));
    }
  };

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    login.mutate();
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">Sign in</h1>

      {ssoFailed && (
        <p role="alert" className="text-sm font-medium text-destructive">
          Single sign-on failed. Try again or sign in with your email and password.
        </p>
      )}

      <Card>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field
              label="Email"
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
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
            <ErrorNote message={login.isError ? errorMessage(login.error) : undefined} />
            <Button type="submit" variant="primary" disabled={login.isPending}>
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Single sign-on</CardTitle>
          <CardDescription>
            Enter your organization slug to see its sign-in options.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field
            label="Organization slug"
            autoComplete="organization"
            value={orgSlug}
            onChange={(e) => {
              setOrgSlug(e.target.value);
            }}
          />
          <Button
            onClick={() => {
              void findSso();
            }}
          >
            Find sign-in options
          </Button>
          <ErrorNote message={ssoError} />
          {providers !== null && providers.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No single sign-on is available for that organization.
            </p>
          )}
          {providers?.map((provider) => (
            <a
              key={provider.id}
              href={`${API_BASE_URL}/auth/oidc/${encodeURIComponent(provider.id)}/start`}
              className={buttonVariants({ variant: 'outline' })}
            >
              Continue with {provider.name}
            </a>
          ))}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        First time here?{' '}
        <Link to="/setup" className="text-primary underline">
          Set up this installation
        </Link>
      </p>
    </div>
  );
}
