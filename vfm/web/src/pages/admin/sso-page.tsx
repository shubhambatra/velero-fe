import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field, inputClass } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import type { Mapping, Provider, Team } from '@/lib/types';

export function SsoPage({ orgId }: { orgId: string }): ReactElement {
  const client = useQueryClient();
  const key = ['org', orgId, 'oidc'];
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);

  const providers = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<{ providers: Provider[] }>(`/orgs/${orgId}/oidc-providers`, { signal }),
  });
  const teams = useQuery({
    queryKey: ['org', orgId, 'teams'],
    queryFn: ({ signal }) => api<{ teams: Team[] }>(`/orgs/${orgId}/teams`, { signal }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/orgs/${orgId}/oidc-providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Single sign-on</h1>
        <Button
          variant="primary"
          onClick={() => {
            setEditing('new');
          }}
        >
          Add provider
        </Button>
      </div>
      <ErrorNote message={providers.isError ? errorMessage(providers.error) : undefined} />
      <ErrorNote message={remove.isError ? errorMessage(remove.error) : undefined} />

      {editing !== null && (
        <ProviderForm
          key={editing === 'new' ? 'new' : editing.id}
          orgId={orgId}
          provider={editing === 'new' ? null : editing}
          teams={teams.data?.teams ?? []}
          onDone={() => {
            setEditing(null);
            void client.invalidateQueries({ queryKey: key });
          }}
        />
      )}

      {providers.data?.providers.length === 0 && (
        <p className="text-sm text-muted-foreground">No identity providers configured.</p>
      )}
      {providers.data?.providers.map((p) => (
        <Card key={p.id}>
          <CardHeader>
            <CardTitle>
              {p.name} {p.enabled ? '' : '(disabled)'}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="break-all font-mono">{p.issuer}</p>
            <p>
              {p.mappings.length} group mapping{p.mappings.length === 1 ? '' : 's'}
            </p>
            <div className="flex gap-2">
              <Button
                aria-label={`Edit ${p.name}`}
                onClick={() => {
                  setEditing(p);
                }}
              >
                Edit
              </Button>
              <Button
                aria-label={`Delete ${p.name}`}
                onClick={() => {
                  remove.mutate(p.id);
                }}
              >
                Delete
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ProviderForm({
  orgId,
  provider,
  teams,
  onDone,
}: {
  orgId: string;
  provider: Provider | null;
  teams: Team[];
  onDone: () => void;
}): ReactElement {
  const [name, setName] = useState(provider?.name ?? '');
  const [issuer, setIssuer] = useState(provider?.issuer ?? '');
  const [clientId, setClientId] = useState(provider?.clientId ?? '');
  // Write-only: the server never returns the secret, so this starts empty and
  // an empty value on edit means "leave the stored secret alone".
  const [clientSecret, setClientSecret] = useState('');
  const [groupClaim, setGroupClaim] = useState(provider?.groupClaim ?? '');
  const [jit, setJit] = useState(provider?.jitEnabled ?? false);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [mappings, setMappings] = useState<Mapping[]>(provider?.mappings ?? []);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        issuer,
        clientId,
        groupClaim: groupClaim.trim() === '' ? null : groupClaim.trim(),
        mappings: mappings.filter((m) => m.group.trim() !== '' && m.teamId !== ''),
        jitEnabled: jit,
        enabled,
        ...(clientSecret === '' ? {} : { clientSecret }),
      };
      return provider === null
        ? api(`/orgs/${orgId}/oidc-providers`, { method: 'POST', body })
        : api(`/orgs/${orgId}/oidc-providers/${provider.id}`, { method: 'PATCH', body });
    },
    onSuccess: onDone,
  });

  const setMapping = (index: number, patch: Partial<Mapping>): void => {
    setMappings((current) => current.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{provider === null ? 'New provider' : `Edit ${provider.name}`}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field
            label="Name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Field
            label="Issuer URL"
            type="url"
            required
            value={issuer}
            onChange={(e) => {
              setIssuer(e.target.value);
            }}
          />
          <Field
            label="Client ID"
            required
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
            }}
          />
          <Field
            label="Client secret"
            type="password"
            autoComplete="new-password"
            required={provider === null}
            placeholder={provider === null ? '' : 'Leave blank to keep the current secret'}
            hint="Write-only. It is never shown again."
            value={clientSecret}
            onChange={(e) => {
              setClientSecret(e.target.value);
            }}
          />
          <Field
            label="Group claim"
            hint="Name of the claim that lists the user's groups."
            value={groupClaim}
            onChange={(e) => {
              setGroupClaim(e.target.value);
            }}
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Group to team mappings</legend>
            {mappings.map((m, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <Field
                  label={`Group ${(i + 1).toString()}`}
                  value={m.group}
                  onChange={(e) => {
                    setMapping(i, { group: e.target.value });
                  }}
                />
                <div className="flex flex-col gap-1">
                  <label htmlFor={`map-team-${i.toString()}`} className="text-sm font-medium">
                    {`Team ${(i + 1).toString()}`}
                  </label>
                  <select
                    id={`map-team-${i.toString()}`}
                    className={inputClass}
                    value={m.teamId}
                    onChange={(e) => {
                      setMapping(i, { teamId: e.target.value });
                    }}
                  >
                    <option value="">Choose a team</option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  onClick={() => {
                    setMappings((c) => c.filter((_, idx) => idx !== i));
                  }}
                >
                  Remove mapping
                </Button>
              </div>
            ))}
            <Button
              onClick={() => {
                setMappings((c) => [...c, { group: '', teamId: '' }]);
              }}
            >
              Add mapping
            </Button>
          </fieldset>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={jit}
              onChange={(e) => {
                setJit(e.target.checked);
              }}
            />
            Create accounts on first sign-in
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
              }}
            />
            Enabled
          </label>

          <ErrorNote message={save.isError ? errorMessage(save.error) : undefined} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={save.isPending}>
              Save provider
            </Button>
            <Button onClick={onDone}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
