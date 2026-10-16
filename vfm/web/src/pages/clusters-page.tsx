import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field } from '@/components/ui/field';
import { api, errorMessage } from '@/lib/client';
import { useOrgs } from '@/lib/session';
import { canAdminister } from '@/lib/types';

type ClusterStatus = 'PENDING' | 'ENROLLED' | 'CONNECTED' | 'DISCONNECTED' | 'DISABLED';

interface Cluster {
  id: string;
  name: string;
  status: ClusterStatus;
  k8sVersion: string | null;
  veleroVersion: string | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
}

/** What the server hands back once when a credential is minted. */
interface Grant {
  bootstrapToken: string;
  expiresAt: string;
  installCommand: string;
}

const TONE: Record<ClusterStatus, 'neutral' | 'ok' | 'warn' | 'error'> = {
  PENDING: 'warn',
  ENROLLED: 'neutral',
  CONNECTED: 'ok',
  DISCONNECTED: 'warn',
  DISABLED: 'error',
};

const when = (value: string | null): string =>
  value === null ? '—' : new Date(value).toLocaleString();

type Pending =
  | { kind: 'disable' | 'rotate'; cluster: Cluster }
  | { kind: 'delete'; cluster: Cluster }
  | undefined;

/**
 * Clusters (PLAN.md §11 screen 2, plus the add-cluster flow of §5.1).
 *
 * The bootstrap token and the install command that embeds it are shown once, in
 * the response to the call that minted them, and live only in this component's
 * state: not in the query cache, storage or the URL. Closing the card discards
 * them, and a new token is one click away.
 */
export function ClustersPage({ orgId }: { orgId: string }): ReactElement {
  const client = useQueryClient();
  const key = ['org', orgId, 'clusters'];
  const { active } = useOrgs(true);
  const admin = canAdminister(active?.orgRole);

  const [name, setName] = useState('');
  const [grant, setGrant] = useState<{ clusterName: string; grant: Grant } | undefined>();
  const [pending, setPending] = useState<Pending>();
  const [typed, setTyped] = useState('');
  const [copied, setCopied] = useState(false);

  const clusters = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<{ clusters: Cluster[] }>(`/orgs/${orgId}/clusters`, { signal }),
  });

  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: () =>
      api<Grant & { cluster: Cluster }>(`/orgs/${orgId}/clusters`, {
        method: 'POST',
        body: { name },
      }),
    onSuccess: async (created) => {
      setGrant({ clusterName: created.cluster.name, grant: created });
      setCopied(false);
      setName('');
      await refresh();
    },
  });

  /** Reissue, rotate and re-enable all end in a fresh token to show. */
  const mint = useMutation({
    mutationFn: ({ cluster, action }: { cluster: Cluster; action: string }) =>
      api<Grant>(`/orgs/${orgId}/clusters/${cluster.id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: async (result, { cluster }) => {
      setGrant({ clusterName: cluster.name, grant: result });
      setCopied(false);
      setPending(undefined);
      await refresh();
    },
  });

  const disable = useMutation({
    mutationFn: (cluster: Cluster) =>
      api(`/orgs/${orgId}/clusters/${cluster.id}/disable`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      setPending(undefined);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (cluster: Cluster) =>
      api(`/orgs/${orgId}/clusters/${cluster.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setPending(undefined);
      setTyped('');
      await refresh();
    },
  });

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    setGrant(undefined);
    create.mutate();
  };

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // The command is on screen to select by hand; failing to reach the
      // clipboard is not worth an error.
      setCopied(false);
    }
  };

  const failure = [create, mint, disable, remove].find((m) => m.isError);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Clusters</h1>

      {grant !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Install the agent on “{grant.clusterName}”</CardTitle>
            <CardDescription>
              Run this on a machine with cluster-admin access to the target cluster. The token is
              single-use, expires {when(grant.grant.expiresAt)}, and is shown only once.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <pre
              aria-label="Install command"
              className="overflow-x-auto rounded-md border border-control p-2 text-xs"
            >
              {grant.grant.installCommand}
            </pre>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  void copy(grant.grant.installCommand);
                }}
              >
                {copied ? 'Copied' : 'Copy command'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setGrant(undefined);
                }}
              >
                I have run it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {admin && (
        <Card>
          <CardHeader>
            <CardTitle>Add a cluster</CardTitle>
            <CardDescription>
              Creates the cluster and a one-time bootstrap token. Nothing is installed until you run
              the command it gives you.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <Field
                label="Cluster name"
                required
                maxLength={63}
                hint="Letters, digits, space, dot, underscore and dash."
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
              <Button type="submit" variant="primary" disabled={create.isPending}>
                Add cluster
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <ErrorNote message={failure === undefined ? undefined : errorMessage(failure.error)} />

      <Card>
        <CardHeader>
          <CardTitle>Your clusters</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <ErrorNote message={clusters.isError ? errorMessage(clusters.error) : undefined} />
          {clusters.data?.clusters.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {admin
                ? 'No clusters yet. Add one above.'
                : 'No clusters are shared with you yet. Ask an administrator for access.'}
            </p>
          )}
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-2">Name</th>
                <th className="p-2">Status</th>
                <th className="p-2">Velero</th>
                <th className="p-2">Agent</th>
                <th className="p-2">Last seen</th>
                {admin && <th className="p-2">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {clusters.data?.clusters.map((c) => (
                <tr key={c.id} className="border-t border-control align-top">
                  <td className="p-2 font-medium">{c.name}</td>
                  <td className="p-2">
                    <Badge tone={TONE[c.status]}>{c.status.toLowerCase()}</Badge>
                  </td>
                  <td className="p-2">{c.veleroVersion ?? '—'}</td>
                  <td className="p-2">{c.agentVersion ?? '—'}</td>
                  <td className="p-2">{when(c.lastSeenAt)}</td>
                  {admin && (
                    <td className="flex flex-wrap gap-2 p-2">
                      {c.status === 'DISABLED' ? (
                        <Button
                          disabled={mint.isPending}
                          onClick={() => {
                            mint.mutate({ cluster: c, action: 'enable' });
                          }}
                        >
                          Enable
                        </Button>
                      ) : (
                        <>
                          <Button
                            disabled={mint.isPending}
                            onClick={() => {
                              mint.mutate({ cluster: c, action: 'bootstrap-token' });
                            }}
                          >
                            New token
                          </Button>
                          <Button
                            onClick={() => {
                              setPending({ kind: 'rotate', cluster: c });
                            }}
                          >
                            Rotate certificate…
                          </Button>
                          <Button
                            onClick={() => {
                              setPending({ kind: 'disable', cluster: c });
                            }}
                          >
                            Disable…
                          </Button>
                        </>
                      )}
                      <Button
                        onClick={() => {
                          setTyped('');
                          setPending({ kind: 'delete', cluster: c });
                        }}
                      >
                        Delete…
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {pending !== undefined && (
        <Card role="alertdialog" aria-labelledby="confirm-title">
          <CardHeader>
            <CardTitle id="confirm-title">
              {pending.kind === 'delete' && `Delete “${pending.cluster.name}”?`}
              {pending.kind === 'disable' && `Disable “${pending.cluster.name}”?`}
              {pending.kind === 'rotate' && `Rotate the certificate of “${pending.cluster.name}”?`}
            </CardTitle>
            <CardDescription>
              {pending.kind === 'delete' &&
                'The cluster and its access grants are removed and its agent is locked out immediately. Backups in the storage location are not touched. Type the cluster name to confirm.'}
              {pending.kind === 'disable' &&
                'Every certificate is revoked and the agent is disconnected. Enable it later to enrol again with a new token.'}
              {pending.kind === 'rotate' &&
                'Every certificate is revoked and the agent must enrol again with a new token, which is shown next. Use this if its key may have leaked.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pending.kind === 'delete' && (
              <Field
                label="Cluster name"
                autoComplete="off"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                }}
              />
            )}
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={
                  mint.isPending ||
                  disable.isPending ||
                  remove.isPending ||
                  (pending.kind === 'delete' && typed !== pending.cluster.name)
                }
                onClick={() => {
                  if (pending.kind === 'delete') {
                    remove.mutate(pending.cluster);
                  } else if (pending.kind === 'disable') {
                    disable.mutate(pending.cluster);
                  } else {
                    mint.mutate({ cluster: pending.cluster, action: 'rotate-certificate' });
                  }
                }}
              >
                Confirm
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setPending(undefined);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
