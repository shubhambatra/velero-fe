import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactElement } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { Area, CopyButton, Select, Text } from '@/components/form-fields';
import { useToasts } from '@/components/toast-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { lacks, useAccess } from '@/lib/access';
import { api, errorMessage } from '@/lib/client';
import {
  emptyLocationForm,
  fromLocationSpec,
  hasLocationErrors,
  PROVIDERS,
  toLocationBody,
  toLocationCli,
  validateLocation,
  type CredentialMode,
  type LocationForm,
  type LocationKind,
} from '@/lib/location-form';
import type { Detail, LocationRow } from '@/lib/resources';

const PATH: Record<LocationKind, string> = {
  backup: 'backup-locations',
  snapshot: 'snapshot-locations',
};

/**
 * Adds a storage location, or changes one when `name` is given (PLAN.md §6, §11.1).
 * A credential typed here goes to the agent once; this page keeps it only in memory and
 * clears it as soon as the request is sent.
 */
export function LocationFormPage({
  orgId,
  clusterId,
  kind,
  name,
}: {
  orgId: string;
  clusterId: string;
  kind: LocationKind;
  name?: string;
}): ReactElement {
  const editing = name !== undefined;
  const access = useAccess(orgId, clusterId);
  const mayWrite = access.level('storage:write') === 'cluster';
  const [form, setForm] = useState<LocationForm>(() => ({
    ...emptyLocationForm(kind),
    name: name ?? '',
  }));
  const [attempted, setAttempted] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const set = <K extends keyof LocationForm>(key: K, value: LocationForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const existing = useQuery({
    enabled: editing,
    queryKey: ['org', orgId, 'cluster', clusterId, 'location-edit', kind, name],
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      api<Detail<LocationRow>>(
        `/orgs/${orgId}/clusters/${clusterId}/${PATH[kind]}/${encodeURIComponent(name ?? '')}`,
        { signal },
      ),
  });
  useEffect(() => {
    if (editing && existing.data !== undefined && !loaded) {
      setForm(fromLocationSpec(kind, name, existing.data.spec));
      setLoaded(true);
    }
  }, [editing, existing.data, loaded, kind, name]);

  const errors = validateLocation(form, editing);
  const shown = (key: keyof typeof errors): string | undefined =>
    attempted ? errors[key] : undefined;

  const { follow } = useToasts();
  const navigate = useNavigate();
  const noun = kind === 'backup' ? 'backup location' : 'snapshot location';
  // The request is built inside the function, so react-query's mutation state never holds the credential.
  const save = useMutation({
    mutationFn: () =>
      api<{ id: string }>(
        editing
          ? `/orgs/${orgId}/clusters/${clusterId}/${PATH[kind]}/${encodeURIComponent(name)}`
          : `/orgs/${orgId}/clusters/${clusterId}/${PATH[kind]}`,
        { method: editing ? 'PUT' : 'POST', body: toLocationBody(form, !editing) },
      ),
    onSuccess: (command) => {
      setForm((f) => ({ ...f, credentialText: '' }));
      follow({
        orgId,
        clusterId,
        commandId: command.id,
        title: `${editing ? 'Change' : 'Add'} ${noun} ${form.name}`,
      });
      void navigate({ to: '/clusters/$clusterId/storage', params: { clusterId } });
    },
  });

  const submit = () => {
    setAttempted(true);
    if (!hasLocationErrors(errors)) {
      save.mutate();
    }
  };

  const cli = toLocationCli(form, editing);
  const modes: { value: CredentialMode; label: string }[] = [
    ...(form.current === null
      ? []
      : [{ value: 'keep' as const, label: 'Keep the Secret it uses now' }]),
    { value: 'new', label: editing ? 'Replace it with a new credential' : 'Paste a credential' },
    { value: 'existing', label: 'Use a Secret that is already in the cluster' },
    ...(editing
      ? []
      : [
          { value: 'none' as const, label: 'None (Velero’s own credentials or workload identity)' },
        ]),
  ];
  const provider = PROVIDERS.find((p) => p.value === form.provider);

  return (
    <ClusterShell
      orgId={orgId}
      clusterId={clusterId}
      tab="storage"
      title={`${editing ? 'Change' : 'Add'} a ${noun}`}
      crumbs={
        <>
          {' / '}
          <Link to="/clusters/$clusterId/storage" params={{ clusterId }} className="underline">
            Storage
          </Link>
        </>
      }
    >
      {!mayWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>You cannot change storage here</CardTitle>
            <CardDescription>{lacks('storage:write')}</CardDescription>
          </CardHeader>
        </Card>
      ) : editing && existing.isError ? (
        <ErrorNote message={errorMessage(existing.error)} />
      ) : editing && !loaded ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <Card>
            <CardContent className="flex flex-col gap-3 pt-4">
              {!editing && (
                <Text
                  label="Name"
                  value={form.name}
                  error={shown('name')}
                  onChange={(v) => {
                    set('name', v);
                  }}
                />
              )}
              <Select
                label="Provider"
                value={PROVIDERS.some((p) => p.value === form.provider) ? form.provider : 'other'}
                options={[
                  ...PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
                  { value: 'other', label: 'Another provider plugin' },
                ]}
                onChange={(v) => {
                  setForm((f) => ({
                    ...f,
                    provider: v === 'other' ? '' : v,
                    settings:
                      !editing && f.settings.every((s) => s.value === '')
                        ? (PROVIDERS.find((p) => p.value === v)?.settings[kind] ?? []).map(
                            (key) => ({
                              key,
                              value: '',
                            }),
                          )
                        : f.settings,
                  }));
                }}
              />
              {!PROVIDERS.some((p) => p.value === form.provider) && (
                <Text
                  label="Provider plugin name"
                  value={form.provider}
                  error={shown('provider')}
                  onChange={(v) => {
                    set('provider', v);
                  }}
                />
              )}
              {kind === 'backup' && (
                <>
                  <Text
                    label="Bucket"
                    value={form.bucket}
                    error={shown('bucket')}
                    onChange={(v) => {
                      set('bucket', v);
                    }}
                  />
                  <Text
                    label="Prefix (optional)"
                    hint="A folder inside the bucket."
                    value={form.prefix}
                    onChange={(v) => {
                      set('prefix', v);
                    }}
                  />
                  <Select
                    label="Access mode"
                    value={form.accessMode}
                    options={[
                      { value: '', label: 'Velero’s default (read and write)' },
                      { value: 'ReadWrite', label: 'Read and write' },
                      { value: 'ReadOnly', label: 'Read only' },
                    ]}
                    onChange={(v) => {
                      set('accessMode', v as LocationForm['accessMode']);
                    }}
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.isDefault}
                      onChange={(e) => {
                        set('isDefault', e.target.checked);
                      }}
                    />
                    Use as the default location for new backups
                  </label>
                  <Text
                    label="Backup sync period (optional)"
                    hint="How often Velero looks for backups in the bucket, such as 1m."
                    value={form.backupSyncPeriod}
                    error={shown('backupSyncPeriod')}
                    onChange={(v) => {
                      set('backupSyncPeriod', v);
                    }}
                  />
                  <Text
                    label="Validation frequency (optional)"
                    hint="How often Velero checks it can reach the bucket, such as 1h."
                    value={form.validationFrequency}
                    error={shown('validationFrequency')}
                    onChange={(v) => {
                      set('validationFrequency', v);
                    }}
                  />
                  <Area
                    label="CA certificate (optional)"
                    hint="PEM text, for a storage endpoint with a private certificate."
                    value={form.caCert}
                    error={shown('caCert')}
                    mono
                    rows={4}
                    onChange={(v) => {
                      set('caCert', v);
                    }}
                  />
                </>
              )}

              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium">Provider settings</legend>
                {provider !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    Common for {provider.value}: {provider.settings[kind].join(', ')}.
                  </p>
                )}
                {form.settings.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Text
                      label={`Setting ${(i + 1).toString()} name`}
                      value={s.key}
                      onChange={(v) => {
                        setForm((f) => ({
                          ...f,
                          settings: f.settings.map((x, j) => (j === i ? { ...x, key: v } : x)),
                        }));
                      }}
                    />
                    <Text
                      label={`Setting ${(i + 1).toString()} value`}
                      value={s.value}
                      onChange={(v) => {
                        setForm((f) => ({
                          ...f,
                          settings: f.settings.map((x, j) => (j === i ? { ...x, value: v } : x)),
                        }));
                      }}
                    />
                    <Button
                      variant="outline"
                      aria-label={`Remove setting ${(i + 1).toString()}`}
                      onClick={() => {
                        setForm((f) => ({ ...f, settings: f.settings.filter((_, j) => j !== i) }));
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <ErrorNote message={shown('settings')} />
                <div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setForm((f) => ({ ...f, settings: [...f.settings, { key: '', value: '' }] }));
                    }}
                  >
                    Add a setting
                  </Button>
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium">Credential</legend>
                <Select
                  label="Where the credential comes from"
                  value={form.credentialMode}
                  options={modes}
                  onChange={(v) => {
                    set('credentialMode', v as CredentialMode);
                  }}
                />
                {form.credentialMode === 'keep' && form.current !== null && (
                  <p className="text-sm text-muted-foreground">
                    Uses the Secret <code>{form.current.name}</code>, key{' '}
                    <code>{form.current.key}</code>.
                  </p>
                )}
                {form.credentialMode === 'existing' && (
                  <>
                    <Text
                      label="Secret name"
                      value={form.secretName}
                      error={shown('secretName')}
                      onChange={(v) => {
                        set('secretName', v);
                      }}
                    />
                    <Text
                      label="Key in the Secret"
                      value={form.secretKey}
                      error={shown('secretKey')}
                      onChange={(v) => {
                        set('secretKey', v);
                      }}
                    />
                  </>
                )}
                {form.credentialMode === 'new' && (
                  <>
                    <Area
                      label="Credential"
                      hint="The text of the key file. It is sent once to the cluster’s agent, which stores it in a Secret. The control plane does not keep it."
                      value={form.credentialText}
                      error={shown('credentialText')}
                      mono
                      masked={!reveal}
                      rows={5}
                      onChange={(v) => {
                        set('credentialText', v);
                      }}
                    />
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={reveal}
                          onChange={(e) => {
                            setReveal(e.target.checked);
                          }}
                        />
                        Show what I typed
                      </label>
                      <label className="flex items-center gap-2">
                        Load from a file
                        <input
                          type="file"
                          aria-label="Load the credential from a file"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file !== undefined) {
                              void file.text().then((t) => {
                                set('credentialText', t);
                              });
                            }
                            e.target.value = '';
                          }}
                        />
                      </label>
                    </div>
                  </>
                )}
              </fieldset>

              <ErrorNote message={save.isError ? errorMessage(save.error) : undefined} />
              <div className="flex gap-2 pt-2">
                <Button variant="primary" onClick={submit} disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : editing ? 'Save changes' : `Add ${noun}`}
                </Button>
                <Link
                  to="/clusters/$clusterId/storage"
                  params={{ clusterId }}
                  className="inline-flex items-center px-3 text-sm underline"
                >
                  Cancel
                </Link>
              </div>
            </CardContent>
          </Card>

          <aside aria-label="Equivalent command">
            <Card>
              <CardHeader>
                <CardTitle>The same with the Velero CLI</CardTitle>
                <CardDescription>Updates as you fill in the form.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <pre
                  aria-label="Equivalent velero command"
                  className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-control bg-background p-3 text-xs"
                >
                  {cli.command}
                </pre>
                {cli.notes.map((note) => (
                  <p key={note} className="text-xs text-muted-foreground">
                    {note}
                  </p>
                ))}
                <CopyButton text={cli.command} />
              </CardContent>
            </Card>
          </aside>
        </div>
      )}
    </ClusterShell>
  );
}
