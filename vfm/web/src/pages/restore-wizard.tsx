import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { Area, CopyButton, Select, Text } from '@/components/form-fields';
import { useToasts } from '@/components/toast-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { useAccess } from '@/lib/access';
import { useApprovalPolicy } from '@/lib/approvals';
import type { ClusterScoped, Tri } from '@/lib/backup-form';
import { api, errorMessage } from '@/lib/client';
import { cn } from '@/lib/cn';
import {
  emptyRestoreForm,
  impactRows,
  impactTargets,
  STEP_FIELDS,
  toBody,
  toCli,
  validate,
  type NamespaceState,
  type Policy,
  type RestoreForm,
  type SourceKind,
} from '@/lib/restore-form';

const STEPS = ['Source', 'Scope', 'Options', 'Review'] as const;

const TRI: { value: Tri; label: string }[] = [
  { value: 'default', label: 'Velero’s default' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

interface Names {
  items: { name: string; phase?: string | null }[];
}

interface CommandState {
  id: string;
  status: string;
  errorMessage: string | null;
  result: { namespaces?: NamespaceState[] } | null;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);

/**
 * Asks the agent which of the target namespaces exist now, once per set of names, and
 * follows the answer. The server only answers for namespaces the caller may restore
 * into, and the agent only for the names it is given.
 */
function useNamespaceCheck(orgId: string, clusterId: string, names: string[], active: boolean) {
  const key = names.join(',');
  const [commandId, setCommandId] = useState<{ key: string; id: string } | undefined>();
  const asked = useRef<string | undefined>(undefined);

  const start = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/orgs/${orgId}/clusters/${clusterId}/restores/impact`, {
        method: 'POST',
        body: { namespaces: names },
      }),
    onSuccess: (command) => {
      setCommandId({ key, id: command.id });
    },
  });
  const { mutate } = start;

  useEffect(() => {
    if (active && names.length > 0 && asked.current !== key) {
      asked.current = key;
      mutate();
    }
  }, [active, key, names.length, mutate]);

  const current = commandId?.key === key ? commandId.id : undefined;
  const command = useQuery<CommandState>({
    queryKey: ['org', orgId, 'cluster', clusterId, 'command', current],
    enabled: current !== undefined,
    refetchInterval: (q) =>
      q.state.data !== undefined && TERMINAL.has(q.state.data.status) ? false : 800,
    refetchIntervalInBackground: true,
    queryFn: ({ signal }) =>
      api<CommandState>(`/orgs/${orgId}/clusters/${clusterId}/commands/${current ?? ''}`, {
        signal,
      }),
  });

  const status = command.data?.status;
  const failed =
    start.isError || status === 'FAILED' || status === 'TIMED_OUT' || status === 'CANCELLED';
  return {
    state:
      names.length === 0
        ? 'none'
        : status === 'SUCCEEDED'
          ? 'done'
          : failed
            ? 'failed'
            : active
              ? 'checking'
              : 'idle',
    report: status === 'SUCCEEDED' ? command.data?.result?.namespaces : undefined,
    message: start.isError
      ? errorMessage(start.error)
      : (command.data?.errorMessage ??
        (status === 'TIMED_OUT'
          ? 'The agent did not answer in time. Is it connected?'
          : undefined)),
    retry: () => {
      asked.current = undefined;
      setCommandId(undefined);
      start.reset();
      mutate();
      asked.current = key;
    },
  } as const;
}

export function RestoreWizardPage({
  orgId,
  clusterId,
}: {
  orgId: string;
  clusterId: string;
}): ReactElement {
  const access = useAccess(orgId, clusterId);
  const createLevel = access.level('restore:create');
  const limited = createLevel === 'scoped';
  const mayUseAdvanced = access.level('advanced:write') === 'cluster';

  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const fromBackup = typeof search.backup === 'string' ? search.backup : '';
  const fromSchedule = typeof search.schedule === 'string' ? search.schedule : '';

  const [form, setForm] = useState<RestoreForm>(() => ({
    ...emptyRestoreForm(false, fromSchedule !== '' ? fromSchedule : fromBackup),
    sourceKind: fromSchedule !== '' ? 'schedule' : 'backup',
  }));
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState<ReadonlySet<number>>(new Set());
  const [adjusted, setAdjusted] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (limited && !adjusted) {
      setForm((f) => ({ ...f, clusterScoped: 'no' }));
      setAdjusted(true);
    }
  }, [limited, adjusted]);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const ctx = { limitedToNamespaces: limited, mayUseAdvanced };
  const errors = validate(form, ctx);
  const set =
    <K extends keyof RestoreForm>(key: K) =>
    (value: RestoreForm[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    };
  const shown = (key: keyof RestoreForm): string | undefined => {
    const owner = Object.entries(STEP_FIELDS).find(([, keys]) => keys.includes(key));
    return owner !== undefined && (attempted.has(Number(owner[0])) || step === 3)
      ? errors[key]
      : undefined;
  };
  const stepHasErrors = (n: number): boolean =>
    (STEP_FIELDS[n] ?? []).some((key) => errors[key] !== undefined);

  // Suggestions for the source: what the cluster has reported.
  const kindPath = form.sourceKind === 'backup' ? 'backups' : 'schedules';
  const sources = useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'wizard-sources', kindPath],
    queryFn: ({ signal }) =>
      api<Names>(`/orgs/${orgId}/clusters/${clusterId}/${kindPath}?limit=200`, { signal }),
  });

  const targets = impactTargets(form);
  const targetNames = useMemo(
    () =>
      step === 3 && targets !== null && !stepHasErrors(1)
        ? [...new Set(targets.map((t) => t.target))]
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [step, form.namespaces, form.mapping],
  );
  const check = useNamespaceCheck(orgId, clusterId, targetNames, step === 3);
  const rows = impactRows(form, check.report);
  const blocked = rows?.some((r) => r.effect === 'blocked') === true;

  const { follow } = useToasts();
  const approval = useApprovalPolicy(orgId, clusterId);
  const [waiting, setWaiting] = useState(false);
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; status?: string }>(`/orgs/${orgId}/clusters/${clusterId}/restores`, {
        method: 'POST',
        body: toBody(form),
      }),
    onSuccess: (command) => {
      if (command.status === 'PENDING_APPROVAL') {
        // Nothing has been sent to the agent: someone else has to approve it first.
        setWaiting(true);
        return;
      }
      follow({
        orgId,
        clusterId,
        commandId: command.id,
        title:
          form.name.trim() === ''
            ? `Restore from ${form.source.trim()}`
            : `Create restore ${form.name.trim()}`,
      });
      void navigate({ to: '/clusters/$clusterId/restores', params: { clusterId } });
    },
  });

  const next = () => {
    setAttempted((a) => new Set(a).add(step));
    if (!stepHasErrors(step)) setStep((s) => Math.min(3, s + 1));
  };
  const submit = () => {
    const firstBad = [0, 1, 2].find(stepHasErrors);
    if (firstBad !== undefined) {
      setAttempted(new Set([0, 1, 2, 3]));
      setStep(firstBad);
      return;
    }
    create.mutate();
  };

  const cli = toCli(form);
  const back = (
    <Link to="/clusters/$clusterId/restores" params={{ clusterId }} className="underline">
      Restores
    </Link>
  );

  return (
    <ClusterShell
      orgId={orgId}
      clusterId={clusterId}
      tab="restores"
      title="Restore"
      crumbs={
        <>
          {' / '}
          {back}
        </>
      }
    >
      {waiting ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for approval</CardTitle>
            <CardDescription>
              Your restore request was recorded. It is not sent to the cluster until another person
              who may restore these namespaces approves it. You can withdraw it from the approvals
              page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to="/approvals" className="underline">
              Go to approvals
            </Link>
          </CardContent>
        </Card>
      ) : createLevel === 'none' ? (
        <Card>
          <CardHeader>
            <CardTitle>You cannot restore here</CardTitle>
            <CardDescription>{access.why('restore:create')}</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <div className="flex flex-col gap-4">
            <ol aria-label="Steps" className="flex flex-wrap gap-2 text-sm">
              {STEPS.map((label, i) => (
                <li
                  key={label}
                  aria-current={i === step ? 'step' : undefined}
                  className={cn(
                    'rounded-md border px-3 py-1',
                    i === step
                      ? 'border-primary font-semibold'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  {`${(i + 1).toString()}. ${label}`}
                  {i < step && stepHasErrors(i) ? ' (needs attention)' : ''}
                </li>
              ))}
            </ol>

            <Card>
              <CardHeader>
                <h2 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
                  {STEPS[step]}
                </h2>
                {limited && step === 1 && (
                  <CardDescription>
                    Your access covers only some namespaces, so every namespace — and every
                    namespace it is mapped to — must be one of them, and cluster-scoped resources
                    are left out.
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {step === 0 && (
                  <>
                    <Select
                      label="Restore from"
                      value={form.sourceKind}
                      onChange={(v) => {
                        setForm((f) => ({ ...f, sourceKind: v as SourceKind, source: '' }));
                      }}
                      options={[
                        { value: 'backup', label: 'A backup' },
                        { value: 'schedule', label: 'A schedule (its latest backup)' },
                      ]}
                    />
                    <Text
                      label={form.sourceKind === 'backup' ? 'Backup' : 'Schedule'}
                      hint={
                        form.sourceKind === 'backup'
                          ? 'Choose from the list or type a name. Only a completed backup can be restored.'
                          : 'Velero restores the most recent successful backup of the schedule.'
                      }
                      error={shown('source')}
                      value={form.source}
                      onChange={set('source')}
                      suggestions={sources.data?.items.map((i) => i.name) ?? []}
                    />
                    <Text
                      label="Name"
                      hint="Optional. Leave empty and the agent names it after the source and the time."
                      error={shown('name')}
                      value={form.name}
                      onChange={set('name')}
                    />
                  </>
                )}

                {step === 1 && (
                  <>
                    <Text
                      label="Namespaces to restore"
                      hint={
                        limited
                          ? 'Comma-separated, for example shop,cart.'
                          : 'Comma-separated. Empty means every namespace in the backup.'
                      }
                      error={shown('namespaces')}
                      value={form.namespaces}
                      onChange={set('namespaces')}
                    />
                    <Text
                      label="Namespaces to leave out"
                      value={form.excludeNamespaces}
                      onChange={set('excludeNamespaces')}
                    />
                    <Text
                      label="Namespace mapping"
                      hint="Restore a namespace under another name: source:target, comma-separated. Both must be namespaces you may restore."
                      error={shown('mapping')}
                      value={form.mapping}
                      onChange={set('mapping')}
                    />
                    <Text
                      label="Resources to include"
                      value={form.includeResources}
                      onChange={set('includeResources')}
                    />
                    <Text
                      label="Resources to exclude"
                      value={form.excludeResources}
                      onChange={set('excludeResources')}
                    />
                    <Select
                      label="Cluster-scoped resources"
                      hint={
                        limited
                          ? 'Not available with your access.'
                          : 'Velero’s default adds the cluster-scoped objects the selected resources need.'
                      }
                      error={shown('clusterScoped')}
                      value={form.clusterScoped}
                      disabled={limited}
                      onChange={(v) => {
                        setForm((f) => ({ ...f, clusterScoped: v as ClusterScoped }));
                      }}
                      options={
                        limited
                          ? [{ value: 'no', label: 'No' }]
                          : [
                              { value: 'auto', label: 'Velero’s default' },
                              { value: 'no', label: 'No' },
                              { value: 'yes', label: 'Yes, include them' },
                            ]
                      }
                    />
                    <Text
                      label="Label selector"
                      hint="Only resources with these labels, for example app=web."
                      error={shown('selector')}
                      value={form.selector}
                      onChange={set('selector')}
                    />
                    <Area
                      label="Alternative label selectors"
                      hint="One per line. A resource matching any line is included."
                      error={shown('orSelectors')}
                      value={form.orSelectors}
                      onChange={set('orSelectors')}
                      rows={2}
                    />
                  </>
                )}

                {step === 2 && (
                  <>
                    <Select
                      label="When a resource already exists"
                      hint="“Leave it” keeps what is there and adds what is missing; “update” changes existing resources to match the backup."
                      value={form.existingResourcePolicy}
                      onChange={(v) => {
                        set('existingResourcePolicy')(v as Policy);
                      }}
                      options={[
                        { value: 'default', label: 'Velero’s default' },
                        { value: 'none', label: 'Leave it' },
                        { value: 'update', label: 'Update it' },
                      ]}
                    />
                    <Select
                      label="Restore persistent volumes"
                      value={form.restorePVs}
                      onChange={(v) => {
                        set('restorePVs')(v as Tri);
                      }}
                      options={TRI}
                    />
                    <Select
                      label="Keep node ports of services"
                      value={form.preserveNodePorts}
                      onChange={(v) => {
                        set('preserveNodePorts')(v as Tri);
                      }}
                      options={TRI}
                    />
                    <Text
                      label="Restore the status of these resources"
                      hint="Comma-separated resource names."
                      value={form.statusInclude}
                      onChange={set('statusInclude')}
                    />
                    <Text
                      label="Do not restore the status of these resources"
                      value={form.statusExclude}
                      onChange={set('statusExclude')}
                    />
                    <Text
                      label="Item operation timeout"
                      error={shown('itemOperationTimeout')}
                      value={form.itemOperationTimeout}
                      onChange={set('itemOperationTimeout')}
                    />
                    <Text
                      label="Resource modifier ConfigMap"
                      hint="The name of a ConfigMap in Velero’s namespace."
                      error={shown('resourceModifier')}
                      value={form.resourceModifier}
                      onChange={set('resourceModifier')}
                    />
                    <Select
                      label="Write sparse files"
                      value={form.writeSparseFiles}
                      onChange={(v) => {
                        set('writeSparseFiles')(v as Tri);
                      }}
                      options={TRI}
                    />
                    <Text
                      label="Parallel file downloads"
                      hint="1 to 64. Empty means Velero’s default."
                      error={shown('parallelFilesDownload')}
                      value={form.parallelFilesDownload}
                      onChange={set('parallelFilesDownload')}
                    />
                    <Area
                      label="Advanced settings (JSON)"
                      hint={
                        mayUseAdvanced
                          ? 'Merged onto the restore spec and checked against Velero’s. For example hooks.'
                          : 'Only administrators of the whole cluster may use this.'
                      }
                      error={shown('advanced')}
                      value={form.advanced}
                      onChange={set('advanced')}
                      disabled={!mayUseAdvanced}
                      rows={5}
                      mono
                    />
                  </>
                )}

                {step === 3 && (
                  <>
                    <section aria-label="Impact" className="flex flex-col gap-2">
                      <h3 className="text-sm font-semibold">What this will touch</h3>
                      {rows === null ? (
                        <p className="text-sm text-muted-foreground">
                          This restores every namespace in{' '}
                          {form.sourceKind === 'backup'
                            ? 'the backup'
                            : 'the schedule’s latest backup'}
                          {form.excludeNamespaces.trim() === ''
                            ? ''
                            : ` except ${form.excludeNamespaces.trim()}`}
                          . The namespaces cannot be listed in advance; name them in the Scope step
                          to see which already exist.
                        </p>
                      ) : (
                        <>
                          <table className="w-full text-left text-sm">
                            <thead>
                              <tr>
                                <th className="p-2">Restores</th>
                                <th className="p-2">Into</th>
                                <th className="p-2">Effect</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r) => (
                                <tr key={r.source} className="border-t border-control align-top">
                                  <td className="p-2 font-mono">{r.source}</td>
                                  <td className="p-2 font-mono">
                                    {r.target}
                                    {r.inPlace ? '' : ' (renamed)'}
                                  </td>
                                  <td className="p-2">
                                    <Badge
                                      tone={
                                        r.effect === 'blocked'
                                          ? 'error'
                                          : r.effect === 'unknown'
                                            ? 'neutral'
                                            : r.effect === 'created'
                                              ? 'ok'
                                              : 'warn'
                                      }
                                    >
                                      {r.effect === 'created'
                                        ? 'New'
                                        : r.effect === 'merged'
                                          ? 'Exists'
                                          : r.effect === 'updated'
                                            ? 'Exists, updated'
                                            : r.effect === 'blocked'
                                              ? 'Being deleted'
                                              : 'Unknown'}
                                    </Badge>{' '}
                                    {r.note}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <p role="status" className="text-xs text-muted-foreground">
                            {check.state === 'checking' &&
                              'Asking the cluster which of these namespaces exist…'}
                            {check.state === 'done' && 'As the cluster reports them now.'}
                          </p>
                          {check.state === 'failed' && (
                            <div className="flex flex-wrap items-center gap-2">
                              <ErrorNote
                                message={`Could not check the cluster: ${check.message ?? 'no answer.'}`}
                              />
                              <Button variant="outline" onClick={check.retry}>
                                Check again
                              </Button>
                            </div>
                          )}
                        </>
                      )}
                    </section>

                    <pre
                      aria-label="Request"
                      className="max-h-72 overflow-auto rounded-md border border-control bg-background p-3 text-xs"
                    >
                      {JSON.stringify(toBody(form), null, 2)}
                    </pre>
                    <p className="text-xs text-muted-foreground">
                      Restoring needs a recent sign-in: you are asked for your password if you have
                      not signed in lately.
                    </p>
                    {[0, 1, 2].some(stepHasErrors) && (
                      <ErrorNote message="Some settings need attention. Use Back to fix them." />
                    )}
                    {blocked && (
                      <ErrorNote message="A target namespace is being deleted. Wait until it is gone, or choose another target." />
                    )}
                    {approval.data?.required === true && (
                      <p role="status" className="text-sm font-medium">
                        This cluster requires approval: your restore will wait until another person
                        approves it.
                      </p>
                    )}
                    <ErrorNote message={create.isError ? errorMessage(create.error) : undefined} />
                  </>
                )}

                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline"
                    disabled={step === 0}
                    onClick={() => {
                      setStep((s) => Math.max(0, s - 1));
                    }}
                  >
                    Back
                  </Button>
                  {step < 3 ? (
                    <Button variant="primary" onClick={next}>
                      Next
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={submit}
                      disabled={create.isPending || blocked}
                    >
                      {create.isPending
                        ? 'Starting…'
                        : approval.data?.required === true
                          ? 'Request restore'
                          : 'Start restore'}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

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
