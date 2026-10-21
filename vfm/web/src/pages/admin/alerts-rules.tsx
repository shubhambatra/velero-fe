import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote, Field, inputClass } from '@/components/ui/field';
import {
  RULE_TYPES,
  RULE_TYPE_ORDER,
  defaultParams,
  type AlertRule,
  type Channel,
  type RuleType,
} from '@/lib/alerts';
import { api, errorMessage } from '@/lib/client';

import type { Named } from './alerts-page';

interface Draft {
  id: string | null;
  name: string;
  type: RuleType;
  /** Empty means every cluster. */
  clusterIds: string[];
  channelIds: string[];
  params: Record<string, number | boolean | string>;
  enabled: boolean;
}

const blank = (): Draft => ({
  id: null,
  name: '',
  type: 'BACKUP_FAILED',
  clusterIds: [],
  channelIds: [],
  params: defaultParams('BACKUP_FAILED'),
  enabled: true,
});

const fromRule = (r: AlertRule): Draft => ({
  id: r.id,
  name: r.name,
  type: r.type,
  clusterIds: r.scope.clusterIds ?? [],
  channelIds: r.channelIds,
  params: { ...defaultParams(r.type), ...r.params },
  enabled: r.enabled,
});

/** Numbers as numbers: an empty or invalid box is left out so the server's default applies. */
function paramsBody(draft: Draft): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const f of RULE_TYPES[draft.type].fields) {
    const v = draft.params[f.key];
    if (f.kind === 'bool') {
      out[f.key] = v === true;
    } else if (v !== '' && v !== undefined && Number.isFinite(Number(v))) {
      out[f.key] = Number(v);
    }
  }
  return out;
}

export function RulesTab({
  orgId,
  clusters,
  channels,
  goToChannels,
}: {
  orgId: string;
  clusters: Named[];
  channels: Channel[];
  goToChannels: () => void;
}): ReactElement {
  const client = useQueryClient();
  const key = ['org', orgId, 'alert-rules'];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);

  const rules = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<{ rules: AlertRule[] }>(`/orgs/${orgId}/alerts/rules`, { signal }),
  });
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = {
        name: d.name.trim(),
        scope: { clusterIds: d.clusterIds },
        params: paramsBody(d),
        channelIds: d.channelIds,
        enabled: d.enabled,
      };
      return d.id === null
        ? api(`/orgs/${orgId}/alerts/rules`, { method: 'POST', body: { ...body, type: d.type } })
        : api(`/orgs/${orgId}/alerts/rules/${d.id}`, { method: 'PATCH', body });
    },
    onSuccess: async () => {
      setDraft(null);
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const toggle = useMutation({
    mutationFn: (r: AlertRule) =>
      api(`/orgs/${orgId}/alerts/rules/${r.id}`, {
        method: 'PATCH',
        body: { enabled: !r.enabled },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: (r: AlertRule) => api(`/orgs/${orgId}/alerts/rules/${r.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setDeleting(null);
      await client.invalidateQueries({ queryKey: key });
    },
  });

  const clusterName = (id: string): string =>
    clusters.find((c) => c.id === id)?.name ?? 'a deleted cluster';
  const channelName = (id: string): string =>
    channels.find((c) => c.id === id)?.name ?? 'a deleted channel';
  const scopeText = (r: AlertRule): string =>
    (r.scope.clusterIds ?? []).length === 0
      ? 'All clusters'
      : (r.scope.clusterIds ?? []).map(clusterName).join(', ');

  return (
    <div className="flex flex-col gap-4">
      {draft === null ? (
        <div>
          <Button
            variant="primary"
            onClick={() => {
              setDraft(blank());
            }}
          >
            New rule
          </Button>
        </div>
      ) : (
        <RuleForm
          draft={draft}
          setDraft={setDraft}
          clusters={clusters}
          channels={channels}
          busy={save.isPending}
          error={save.isError ? errorMessage(save.error) : undefined}
          onSubmit={() => {
            save.mutate(draft);
          }}
          onCancel={() => {
            save.reset();
            setDraft(null);
          }}
          goToChannels={goToChannels}
        />
      )}

      <ErrorNote message={rules.isError ? errorMessage(rules.error) : undefined} />
      <ErrorNote message={toggle.isError ? errorMessage(toggle.error) : undefined} />
      {rules.data?.rules.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No rules yet. A rule watches your clusters and tells your channels when something is
          wrong.
        </p>
      )}
      {rules.data !== undefined && rules.data.rules.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="p-2">Rule</th>
                <th className="p-2">Watches</th>
                <th className="p-2">Tells</th>
                <th className="p-2">State</th>
                <th className="p-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.data.rules.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="p-2">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">{RULE_TYPES[r.type].label}</div>
                  </td>
                  <td className="p-2">{scopeText(r)}</td>
                  <td className="p-2">
                    {r.channelIds.length === 0 ? (
                      <span className="text-muted-foreground">nobody yet</span>
                    ) : (
                      r.channelIds.map(channelName).join(', ')
                    )}
                  </td>
                  <td className="p-2">
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge tone={r.enabled ? 'ok' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge>
                      {r.firing > 0 && (
                        <Badge tone="error">{`${r.firing.toString()} firing`}</Badge>
                      )}
                    </span>
                  </td>
                  <td className="p-2">
                    <span className="flex flex-wrap gap-1">
                      <Button
                        variant="outline"
                        aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} ${r.name}`}
                        onClick={() => {
                          toggle.mutate(r);
                        }}
                      >
                        {r.enabled ? 'Turn off' : 'Turn on'}
                      </Button>
                      <Button
                        variant="outline"
                        aria-label={`Edit ${r.name}`}
                        onClick={() => {
                          setDraft(fromRule(r));
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        aria-label={`Delete ${r.name}`}
                        onClick={() => {
                          setDeleting(r);
                        }}
                      >
                        Delete
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deleting !== null && (
        <ConfirmDelete
          name={deleting.name}
          title="Delete this rule?"
          consequence="The rule and its history are removed. Nothing is sent about alerts that are still open."
          confirmLabel="Delete rule"
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

function RuleForm({
  draft,
  setDraft,
  clusters,
  channels,
  busy,
  error,
  onSubmit,
  onCancel,
  goToChannels,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  clusters: Named[];
  channels: Channel[];
  busy: boolean;
  error: string | undefined;
  onSubmit: () => void;
  onCancel: () => void;
  goToChannels: () => void;
}): ReactElement {
  const meta = RULE_TYPES[draft.type];
  const flip = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{draft.id === null ? 'New rule' : 'Edit rule'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
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
            Alert when
            <select
              className={inputClass}
              value={draft.type}
              disabled={draft.id !== null}
              onChange={(e) => {
                const type = e.target.value as RuleType;
                setDraft({ ...draft, type, params: defaultParams(type) });
              }}
            >
              {RULE_TYPE_ORDER.map((t) => (
                <option key={t} value={t}>
                  {RULE_TYPES[t].label}
                </option>
              ))}
            </select>
            <span className="text-xs font-normal text-muted-foreground">{meta.description}</span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            {meta.fields.map((f) =>
              f.kind === 'bool' ? (
                <label key={f.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.params[f.key] === true}
                    onChange={(e) => {
                      setDraft({
                        ...draft,
                        params: { ...draft.params, [f.key]: e.target.checked },
                      });
                    }}
                  />
                  {f.label}
                </label>
              ) : (
                <Field
                  key={f.key}
                  label={`${f.label}${f.unit === undefined ? '' : ` (${f.unit})`}`}
                  type="number"
                  inputMode="decimal"
                  min={f.min}
                  max={f.max}
                  step={f.kind === 'int' ? 1 : 0.1}
                  hint={f.hint}
                  value={String(draft.params[f.key] ?? '')}
                  onChange={(e) => {
                    setDraft({ ...draft, params: { ...draft.params, [f.key]: e.target.value } });
                  }}
                />
              ),
            )}
          </div>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">Clusters</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.clusterIds.length === 0}
                onChange={() => {
                  setDraft({ ...draft, clusterIds: [] });
                }}
              />
              All clusters, including ones added later
            </label>
            {clusters.map((c) => (
              <label key={c.id} className="flex items-center gap-2 pl-6 text-sm">
                <input
                  type="checkbox"
                  checked={draft.clusterIds.includes(c.id)}
                  onChange={() => {
                    setDraft({ ...draft, clusterIds: flip(draft.clusterIds, c.id) });
                  }}
                />
                {c.name}
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">Tell</legend>
            {channels.length === 0 && (
              <p className="text-sm text-muted-foreground">
                There are no channels yet, so nobody would be told.{' '}
                <button type="button" className="underline" onClick={goToChannels}>
                  Add a channel
                </button>
              </p>
            )}
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.channelIds.includes(c.id)}
                  onChange={() => {
                    setDraft({ ...draft, channelIds: flip(draft.channelIds, c.id) });
                  }}
                />
                {c.name}
              </label>
            ))}
          </fieldset>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => {
                setDraft({ ...draft, enabled: e.target.checked });
              }}
            />
            Rule is on
          </label>
          <ErrorNote message={error} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy || draft.name.trim() === ''}>
              {draft.id === null ? 'Create rule' : 'Save rule'}
            </Button>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
