import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field, inputClass } from '@/components/ui/field';
import { CHANNEL_LABEL, parseRecipients, type Channel, type ChannelType } from '@/lib/alerts';
import { api, errorMessage } from '@/lib/client';

interface Draft {
  id: string | null;
  name: string;
  type: ChannelType;
  recipients: string;
  url: string;
}

const blank = (): Draft => ({ id: null, name: '', type: 'WEBHOOK', recipients: '', url: '' });

const describe = (c: Channel): string =>
  c.type === 'EMAIL' ? (c.config.to ?? []).join(', ') : (c.config.destination ?? '');

/** Where alerts go (PLAN.md §16 day 33). A destination is shown as its origin only: the rest of a URL is a credential. */
export function ChannelsTab({ orgId }: { orgId: string }): ReactElement {
  const client = useQueryClient();
  const key = ['org', orgId, 'channels'];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  /** The signing secret of a webhook, from the one answer that carries it. */
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [tested, setTested] = useState<Record<string, { ok: boolean; error?: string } | 'sending'>>(
    {},
  );

  const list = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<{ channels: Channel[] }>(`/orgs/${orgId}/channels`, { signal }),
  });
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const config =
        d.type === 'EMAIL' ? { to: parseRecipients(d.recipients) } : { url: d.url.trim() };
      return d.id === null
        ? api<Channel>(`/orgs/${orgId}/channels`, {
            method: 'POST',
            body: { name: d.name.trim(), type: d.type, config },
          })
        : api<Channel>(`/orgs/${orgId}/channels/${d.id}`, {
            method: 'PATCH',
            body: {
              name: d.name.trim(),
              ...(config.to?.length === 0 || config.url === '' ? {} : { config }),
            },
          });
    },
    onSuccess: async (channel) => {
      setDraft(null);
      if (channel.secret !== undefined) setSecret({ name: channel.name, value: channel.secret });
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const rotate = useMutation({
    mutationFn: (c: Channel) =>
      api<Channel>(`/orgs/${orgId}/channels/${c.id}`, {
        method: 'PATCH',
        body: { rotateSecret: true },
      }),
    onSuccess: (channel) => {
      if (channel.secret !== undefined) setSecret({ name: channel.name, value: channel.secret });
    },
  });
  const remove = useMutation({
    mutationFn: (c: Channel) => api(`/orgs/${orgId}/channels/${c.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setDeleting(null);
      await client.invalidateQueries({ queryKey: key });
      await client.invalidateQueries({ queryKey: ['org', orgId, 'alert-rules'] });
    },
  });
  const test = async (c: Channel): Promise<void> => {
    setTested((t) => ({ ...t, [c.id]: 'sending' }));
    try {
      const result = await api<{ ok: boolean; error?: string }>(
        `/orgs/${orgId}/channels/${c.id}/test`,
        { method: 'POST', body: {} },
      );
      setTested((t) => ({ ...t, [c.id]: result }));
    } catch (error: unknown) {
      setTested((t) => ({ ...t, [c.id]: { ok: false, error: errorMessage(error) } }));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {secret !== null && (
        <div role="status" className="rounded-md border border-border bg-card p-3 text-sm">
          <p className="font-medium">{`Signing secret for ${secret.name}`}</p>
          <p className="text-muted-foreground">
            Shown once. Receivers check <code>X-VFM-Signature</code>, an HMAC-SHA256 of the
            timestamp, a dot and the body, made with this secret.
          </p>
          <code className="mt-2 block break-all rounded bg-muted p-2" aria-label="Signing secret">
            {secret.value}
          </code>
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(secret.value).catch(() => undefined);
              }}
            >
              Copy
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSecret(null);
              }}
            >
              I have saved it
            </Button>
          </div>
        </div>
      )}

      {draft === null ? (
        <div>
          <Button
            variant="primary"
            onClick={() => {
              setDraft(blank());
            }}
          >
            New channel
          </Button>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{draft.id === null ? 'New channel' : 'Edit channel'}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(draft);
              }}
            >
              <Field
                label="Name"
                required
                maxLength={100}
                value={draft.name}
                onChange={(e) => {
                  setDraft({ ...draft, name: e.target.value });
                }}
              />
              <label className="flex flex-col gap-1 text-sm font-medium">
                Kind
                <select
                  className={inputClass}
                  value={draft.type}
                  disabled={draft.id !== null}
                  onChange={(e) => {
                    setDraft({ ...draft, type: e.target.value as ChannelType });
                  }}
                >
                  {(Object.keys(CHANNEL_LABEL) as ChannelType[]).map((t) => (
                    <option key={t} value={t}>
                      {CHANNEL_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              {draft.type === 'EMAIL' ? (
                <label className="flex flex-col gap-1 text-sm font-medium">
                  Recipients
                  <textarea
                    className={`${inputClass} h-24 py-2`}
                    value={draft.recipients}
                    placeholder="ops@example.com, oncall@example.com"
                    onChange={(e) => {
                      setDraft({ ...draft, recipients: e.target.value });
                    }}
                  />
                  <span className="text-xs font-normal text-muted-foreground">
                    Separate addresses with commas or new lines. Needs the server’s mail settings.
                  </span>
                </label>
              ) : (
                <Field
                  label="URL"
                  type="url"
                  required={draft.id === null}
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.url}
                  placeholder={
                    draft.id === null ? 'https://' : 'Leave empty to keep the current address'
                  }
                  hint={
                    draft.type === 'WEBHOOK'
                      ? 'Receives a signed JSON POST. Addresses on private networks need the server to allow them.'
                      : 'An incoming-webhook URL of Slack, Mattermost or anything that takes {"text": …}. Treat it as a password.'
                  }
                  onChange={(e) => {
                    setDraft({ ...draft, url: e.target.value });
                  }}
                />
              )}
              <ErrorNote message={save.isError ? errorMessage(save.error) : undefined} />
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={save.isPending || draft.name.trim() === ''}
                >
                  {draft.id === null ? 'Create channel' : 'Save channel'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    save.reset();
                    setDraft(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <ErrorNote message={list.isError ? errorMessage(list.error) : undefined} />
      <ErrorNote message={rotate.isError ? errorMessage(rotate.error) : undefined} />
      {list.data?.channels.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No channels yet. Add one, press Send test, then name it in a rule.
        </p>
      )}
      {list.data?.channels.map((c) => {
        const result = tested[c.id];
        return (
          <Card key={c.id}>
            <CardHeader>
              <CardTitle>{c.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <p>
                <span className="text-muted-foreground">{CHANNEL_LABEL[c.type]}</span>
                {' · '}
                <span className="break-all font-mono">{describe(c)}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  aria-label={`Send a test through ${c.name}`}
                  disabled={result === 'sending'}
                  onClick={() => {
                    void test(c);
                  }}
                >
                  {result === 'sending' ? 'Sending…' : 'Send test'}
                </Button>
                <Button
                  variant="outline"
                  aria-label={`Edit ${c.name}`}
                  onClick={() => {
                    setDraft({
                      id: c.id,
                      name: c.name,
                      type: c.type,
                      recipients: (c.config.to ?? []).join(', '),
                      url: '',
                    });
                  }}
                >
                  Edit
                </Button>
                {c.type === 'WEBHOOK' && (
                  <Button
                    variant="outline"
                    aria-label={`Make a new secret for ${c.name}`}
                    onClick={() => {
                      rotate.mutate(c);
                    }}
                  >
                    New secret
                  </Button>
                )}
                <Button
                  variant="outline"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => {
                    setDeleting(c);
                  }}
                >
                  Delete
                </Button>
              </div>
              {result !== undefined && result !== 'sending' && (
                <p role="status" className={result.ok ? 'text-ok' : 'font-medium text-destructive'}>
                  {result.ok ? 'Test sent.' : `Test failed: ${result.error ?? 'unknown error'}.`}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
      {deleting !== null && (
        <ConfirmDelete
          name={deleting.name}
          title="Delete this channel?"
          consequence="It is removed from every rule that names it. Alerts that rely on it only will tell nobody."
          confirmLabel="Delete channel"
          busy={remove.isPending}
          error={remove.isError ? errorMessage(remove.error) : undefined}
          onConfirm={() => {
            remove.mutate(deleting);
          }}
          onCancel={() => {
            remove.reset();
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}
