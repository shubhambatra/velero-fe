import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { useResetSession, useSession } from '@/lib/session';

/**
 * Where the link in an invitation email lands (`/invite?token=…`).
 *
 * A signed-in user accepts with their own account; the server insists the
 * account holds the invited address. Anyone else creates an account, which is
 * the only way a user comes into being after first-run setup (PLAN.md §8.1).
 */
export function InvitePage({ token }: { token: string | undefined }): ReactElement {
  const session = useSession();
  const reset = useResetSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const finish = async (mfaPendingReason: string | null | undefined): Promise<void> => {
    await reset();
    await navigate({
      to: mfaPendingReason === null || mfaPendingReason === undefined ? '/' : '/mfa',
    });
  };

  const register = useMutation({
    mutationFn: () =>
      api<{ mfaPendingReason: string | null }>('/invites/register', {
        method: 'POST',
        body: { token, password, ...(name.trim() === '' ? {} : { name }) },
      }),
    onSuccess: (result) => finish(result.mfaPendingReason),
  });

  const accept = useMutation({
    mutationFn: () => api('/invites/accept', { method: 'POST', body: { token } }),
    onSuccess: () => finish(null),
  });

  if (token === undefined || token === '') {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Invitation</CardTitle>
          <CardDescription>
            This link is missing its token. Ask for a new invitation.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    register.mutate();
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-xl font-semibold">Accept your invitation</h1>

      {session.status === 'ready' ? (
        <Card>
          <CardHeader>
            <CardTitle>Join with your account</CardTitle>
            <CardDescription>
              You are signed in as {session.user.email}. The invitation must have been sent to this
              address.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ErrorNote message={accept.isError ? errorMessage(accept.error) : undefined} />
            <Button
              variant="primary"
              disabled={accept.isPending}
              onClick={() => {
                accept.mutate();
              }}
            >
              Accept invitation
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Create your account</CardTitle>
            <CardDescription>
              Choose a password of at least 12 characters. Your email address is the one the
              invitation was sent to.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Field
                label="Name (optional)"
                autoComplete="name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
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
              <ErrorNote message={register.isError ? errorMessage(register.error) : undefined} />
              <Button type="submit" variant="primary" disabled={register.isPending}>
                Create account
              </Button>
            </form>
            <p className="mt-3 text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link to="/login" className="underline">
                Sign in
              </Link>{' '}
              and open this link again.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
