import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@vfm/shared';
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';

interface Token {
  id: string;
  name: string;
  prefix: string;
  permissions: string[] | null;
  clusterIds: string[] | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  ownerEmail?: string;
}

const when = (value: string | null): string =>
  value === null ? '—' : new Date(value).toLocaleString();

/**
 * Your API tokens (PLAN.md §11 screen 9). The secret is shown once, in the
 * response to creating it, and is held only in this component's state — never
 * in the query cache, local storage or the URL.
 */
export function TokensPage({ orgId }: { orgId: string }): ReactElement {
  const client = useQueryClient();
  const key = ['org', orgId, 'tokens'];
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [limited, setLimited] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [secret, setSecret] = useState<string | undefined>();

  const tokens = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<{ tokens: Token[] }>(`/orgs/${orgId}/tokens`, { signal }),
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ token: string }>(`/orgs/${orgId}/tokens`, {
        method: 'POST',
        body: {
          name,
          ...(days.trim() === '' ? {} : { expiresInDays: Number(days) }),
          ...(limited ? { permissions: [...picked] } : {}),
        },
      }),
    onSuccess: async (created) => {
      setSecret(created.token);
      setName('');
      await client.invalidateQueries({ queryKey: key });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/orgs/${orgId}/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    setSecret(undefined);
    create.mutate();
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-semibold">API tokens</h1>

      {secret !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Copy your token now</CardTitle>
            <CardDescription>
              It is shown only once. Only a hash is kept, so it cannot be recovered.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <code className="break-all rounded-md border border-control p-2 text-sm">{secret}</code>
            <Button
              onClick={() => {
                setSecret(undefined);
              }}
            >
              I have copied it
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New token</CardTitle>
          <CardDescription>
            A token acts as you and can only ever have less access than you do.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field
              label="Name"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
            <Field
              label="Expires in (days)"
              type="number"
              min={1}
              max={365}
              hint="Leave empty for a token that never expires."
              value={days}
              onChange={(e) => {
                setDays(e.target.value);
              }}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={limited}
                onChange={(e) => {
                  setLimited(e.target.checked);
                }}
              />
              Limit to specific permissions
            </label>
            {limited && (
              <fieldset className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                <legend className="sr-only">Permissions</legend>
                {PERMISSIONS.map((permission) => (
                  <label key={permission} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.has(permission)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) {
                          next.add(permission);
                        } else {
                          next.delete(permission);
                        }
                        setPicked(next);
                      }}
                    />
                    {permission}
                  </label>
                ))}
              </fieldset>
            )}
            <ErrorNote message={create.isError ? errorMessage(create.error) : undefined} />
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Create token
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your tokens</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <ErrorNote message={tokens.isError ? errorMessage(tokens.error) : undefined} />
          <ErrorNote message={revoke.isError ? errorMessage(revoke.error) : undefined} />
          {tokens.data?.tokens.length === 0 && (
            <p className="text-sm text-muted-foreground">No tokens yet.</p>
          )}
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Name</th>
                <th className="p-2">Prefix</th>
                <th className="p-2">Limits</th>
                <th className="p-2">Expires</th>
                <th className="p-2">Last used</th>
                <th className="p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.data?.tokens.map((t) => (
                <tr key={t.id} className="border-t border-control">
                  <td className="p-2">{t.name}</td>
                  <td className="p-2 font-mono">{t.prefix}…</td>
                  <td className="p-2">
                    {t.permissions === null
                      ? 'All of yours'
                      : `${t.permissions.length.toString()} permissions`}
                  </td>
                  <td className="p-2">{when(t.expiresAt)}</td>
                  <td className="p-2">{when(t.lastUsedAt)}</td>
                  <td className="p-2">
                    {t.revokedAt === null ? (
                      <Button
                        disabled={revoke.isPending}
                        onClick={() => {
                          revoke.mutate(t.id);
                        }}
                      >
                        Revoke
                      </Button>
                    ) : (
                      'Revoked'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
