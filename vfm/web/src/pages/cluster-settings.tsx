import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { ConfirmDelete } from '@/components/confirm-delete';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field, inputClass } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { formatLabels, parseLabels } from '@/lib/cluster-settings';
import type { ClusterOverview } from '@/lib/fleet';
import { useOrgs } from '@/lib/session';
import { canAdminister } from '@/lib/types';

interface Grant {
  bootstrapToken: string;
  expiresAt: string;
  installCommand: string;
}

type Action = 'rotate' | 'disable' | 'delete';

/**
 * Cluster settings (PLAN.md section 11.1 page 3): its name, labels and Grafana link, and the actions that
 * revoke or remove it. A new bootstrap token and its install command are shown once, in this
 * component's state only.
 */
export function ClusterSettingsPage({
  orgId,
  clusterId,
}: {
  orgId: string;
  clusterId: string;
}): ReactElement {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { active } = useOrgs(true);
  const admin = canAdminister(active?.orgRole);
  const overviewKey = ['org', orgId, 'cluster', clusterId, 'overview'];

  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: ({ signal }) =>
      api<ClusterOverview>(`/orgs/${orgId}/clusters/${clusterId}/overview`, { signal }),
  });
  const cluster = overview.data?.cluster;

  return (
    <ClusterShell orgId={orgId} clusterId={clusterId} tab="settings">
      {cluster === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <SettingsBody
          key={cluster.id}
          orgId={orgId}
          cluster={cluster}
          admin={admin}
          onChanged={() => client.invalidateQueries({ queryKey: overviewKey })}
          onDeleted={async () => {
            await client.invalidateQueries({ queryKey: ['org', orgId] });
            await navigate({ to: '/clusters' });
          }}
        />
      )}
    </ClusterShell>
  );
}

function SettingsBody({
  orgId,
  cluster,
  admin,
  onChanged,
  onDeleted,
}: {
  orgId: string;
  cluster: ClusterOverview['cluster'];
  admin: boolean;
  onChanged: () => Promise<unknown>;
  onDeleted: () => Promise<void>;
}): ReactElement {
  const base = `/orgs/${orgId}/clusters/${cluster.id}`;
  const [name, setName] = useState(cluster.name);
  const [labels, setLabels] = useState(formatLabels(cluster.labels));
  const [grafana, setGrafana] = useState(cluster.grafanaUrlTemplate ?? '');
  const [formError, setFormError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState<Action | undefined>();
  const [grant, setGrant] = useState<Grant | undefined>();

  const save = useMutation({
    mutationFn: (body: object) => api(base, { method: 'PATCH', body }),
    onSuccess: async () => {
      setSaved(true);
      await onChanged();
    },
  });
  const mint = useMutation({
    mutationFn: (action: string) => api<Grant>(`${base}/${action}`, { method: 'POST', body: {} }),
    onSuccess: async (result) => {
      setGrant(result);
      setPending(undefined);
      await onChanged();
    },
  });
  const disable = useMutation({
    mutationFn: () => api(`${base}/disable`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      setPending(undefined);
      await onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(base, { method: 'DELETE' }),
    onSuccess: onDeleted,
  });

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    setSaved(false);
    const parsed = parseLabels(labels);
    if ('error' in parsed) {
      setFormError(parsed.error);
      return;
    }
    setFormError(undefined);
    save.mutate({
      name: name.trim(),
      labels: parsed.labels,
      grafanaUrlTemplate: grafana.trim() === '' ? null : grafana.trim(),
    });
  };

  const busy = mint.isPending || disable.isPending || remove.isPending;
  const failure = mint.error ?? disable.error ?? remove.error;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>
            The name and labels are for people. The Grafana link adds a button to this
            cluster&rsquo;s header: <code>{'{cluster}'}</code> becomes its name and{' '}
            <code>{'{clusterId}'}</code> its id.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field
              label="Name"
              required
              value={name}
              disabled={!admin}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
            <div className="flex flex-col gap-1">
              <label htmlFor="cluster-labels" className="text-sm font-medium">
                Labels
              </label>
              <textarea
                id="cluster-labels"
                rows={4}
                className={`${inputClass} h-auto py-2 font-mono`}
                value={labels}
                disabled={!admin}
                onChange={(e) => {
                  setLabels(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">One per line, as key=value.</p>
            </div>
            <Field
              label="Grafana URL template"
              type="url"
              placeholder="https://grafana.example/d/abc?var-cluster={cluster}"
              value={grafana}
              disabled={!admin}
              onChange={(e) => {
                setGrafana(e.target.value);
              }}
            />
            <ErrorNote
              message={formError ?? (save.isError ? errorMessage(save.error) : undefined)}
            />
            {saved && (
              <p role="status" className="text-sm">
                Saved.
              </p>
            )}
            <div>
              <Button type="submit" variant="primary" disabled={!admin || save.isPending}>
                Save
              </Button>
              {!admin && (
                <span className="ml-2 text-sm text-muted-foreground">
                  Only organization Owners and Admins can change these.
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      {grant !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Install the agent with this</CardTitle>
            <CardDescription>
              Shown once, valid until <time>{new Date(grant.expiresAt).toLocaleString()}</time>, and
              usable once.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <pre className="overflow-x-auto rounded-md border border-control p-2 text-xs">
              {grant.installCommand}
            </pre>
            <div>
              <Button
                onClick={() => {
                  setGrant(undefined);
                }}
              >
                I have copied it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {admin && (
        <Card>
          <CardHeader>
            <CardTitle>Credentials and removal</CardTitle>
            <CardDescription>
              These lock the agent out or remove the cluster here. Backups in the storage location
              are never touched.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ErrorNote message={failure === null ? undefined : errorMessage(failure)} />
            {pending === undefined ? (
              <div className="flex flex-wrap gap-2">
                {cluster.status === 'DISABLED' ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      mint.mutate('enable');
                    }}
                  >
                    Enable
                  </Button>
                ) : (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        mint.mutate('bootstrap-token');
                      }}
                    >
                      New token
                    </Button>
                    <Button
                      onClick={() => {
                        setPending('rotate');
                      }}
                    >
                      Rotate certificate…
                    </Button>
                    <Button
                      onClick={() => {
                        setPending('disable');
                      }}
                    >
                      Disable…
                    </Button>
                  </>
                )}
                <Button
                  onClick={() => {
                    setPending('delete');
                  }}
                >
                  Delete…
                </Button>
              </div>
            ) : (
              <ConfirmDelete
                name={cluster.name}
                title={
                  pending === 'delete'
                    ? `Delete “${cluster.name}”?`
                    : pending === 'disable'
                      ? `Disable “${cluster.name}”?`
                      : `Rotate the certificate of “${cluster.name}”?`
                }
                consequence={
                  pending === 'delete'
                    ? 'The cluster and its access grants are removed and its agent is locked out immediately.'
                    : pending === 'disable'
                      ? 'Every certificate is revoked and the agent is disconnected. Enable it later to enrol again with a new token.'
                      : 'Every certificate is revoked and the agent must enrol again with a new token, which is shown next. Use this if its key may have leaked.'
                }
                confirmLabel={
                  pending === 'delete'
                    ? 'Delete cluster'
                    : pending === 'disable'
                      ? 'Disable'
                      : 'Rotate'
                }
                busyLabel={pending === 'delete' ? 'Deleting…' : 'Working…'}
                busy={busy}
                error={undefined}
                onConfirm={() => {
                  if (pending === 'delete') remove.mutate();
                  else if (pending === 'disable') disable.mutate();
                  else mint.mutate('rotate-certificate');
                }}
                onCancel={() => {
                  setPending(undefined);
                }}
              />
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
