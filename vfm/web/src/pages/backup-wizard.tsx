import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { useToasts } from '@/components/toast-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { lacks, useAccess } from '@/lib/access';
import {
  emptyForm,
  STEP_FIELDS,
  toBody,
  toCli,
  validate,
  type BackupForm,
  type ClusterScoped,
  type Tri,
} from '@/lib/backup-form';
import { api, errorMessage } from '@/lib/client';
import { cn } from '@/lib/cn';
import { Area, CopyButton, Select, Text } from '@/components/form-fields';

const STEPS = ['What to back up', 'Storage and volumes', 'Options', 'Review'] as const;

interface NamedList {
  items: { name: string; isDefault?: boolean }[];
}

const TRI: { value: Tri; label: string }[] = [
  { value: 'default', label: 'Velero’s default' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

// ---------------------------------------------------------------------------

export function BackupWizardPage({
  orgId,
  clusterId,
}: {
  orgId: string;
  clusterId: string;
}): ReactElement {
  const access = useAccess(orgId, clusterId);
  const createLevel = access.level('backup:create');
  const limited = createLevel === 'scoped';
  const mayUseAdvanced = access.level('advanced:write') === 'cluster';

  const [form, setForm] = useState<BackupForm>(() => emptyForm(false));
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState<ReadonlySet<number>>(new Set());
  const [adjusted, setAdjusted] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // Once we know the user is limited to some namespaces, start from the only
  // setting that works for them — unless they have already chosen.
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
    <K extends keyof BackupForm>(key: K) =>
    (value: BackupForm[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    };
  const shown = (key: keyof BackupForm): string | undefined => {
    const owner = Object.entries(STEP_FIELDS).find(([, keys]) => keys.includes(key));
    return owner !== undefined && (attempted.has(Number(owner[0])) || step === 3)
      ? errors[key]
      : undefined;
  };
  const stepHasErrors = (n: number): boolean =>
    (STEP_FIELDS[n] ?? []).some((key) => errors[key] !== undefined);

  const backupLocations = useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'wizard-bsl'],
    queryFn: ({ signal }) =>
      api<NamedList>(`/orgs/${orgId}/clusters/${clusterId}/backup-locations?limit=200`, { signal }),
  });
  const snapshotLocations = useQuery({
    queryKey: ['org', orgId, 'cluster', clusterId, 'wizard-vsl'],
    queryFn: ({ signal }) =>
      api<NamedList>(`/orgs/${orgId}/clusters/${clusterId}/snapshot-locations?limit=200`, {
        signal,
      }),
  });

  const { follow } = useToasts();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/orgs/${orgId}/clusters/${clusterId}/backups`, {
        method: 'POST',
        body: toBody(form),
      }),
    onSuccess: (command) => {
      follow({
        orgId,
        clusterId,
        commandId: command.id,
        title: form.name.trim() === '' ? 'Create backup' : `Create backup ${form.name.trim()}`,
      });
      void navigate({ to: '/clusters/$clusterId/backups', params: { clusterId } });
    },
  });

  const next = () => {
    setAttempted((a) => new Set(a).add(step));
    if (!stepHasErrors(step)) {
      setStep((s) => Math.min(3, s + 1));
    }
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
    <Link to="/clusters/$clusterId/backups" params={{ clusterId }} className="underline">
      Backups
    </Link>
  );

  const locationOptions = (list: NamedList | undefined, none: string) => [
    { value: '', label: none },
    ...(list?.items ?? []).map((l) => ({
      value: l.name,
      label: l.isDefault === true ? `${l.name} (default)` : l.name,
    })),
  ];

  return (
    <ClusterShell
      orgId={orgId}
      clusterId={clusterId}
      tab="backups"
      title="Create a backup"
      crumbs={
        <>
          {' / '}
          {back}
        </>
      }
    >
      {createLevel === 'none' ? (
        <Card>
          <CardHeader>
            <CardTitle>You cannot create backups here</CardTitle>
            <CardDescription>{lacks('backup:create')}</CardDescription>
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
                {limited && step === 0 && (
                  <CardDescription>
                    Your access covers only some namespaces, so every namespace to back up must be
                    named and cluster-scoped resources are left out.
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {step === 0 && (
                  <>
                    <Text
                      label="Name"
                      hint="Optional. Leave empty and the agent names it backup- followed by the time."
                      error={shown('name')}
                      value={form.name}
                      onChange={set('name')}
                    />
                    <Text
                      label="Namespaces to include"
                      hint={
                        limited
                          ? 'Comma-separated, for example shop,cart.'
                          : 'Comma-separated. Empty means all namespaces.'
                      }
                      error={shown('namespaces')}
                      value={form.namespaces}
                      onChange={set('namespaces')}
                    />
                    <Text
                      label="Namespaces to exclude"
                      error={shown('excludeNamespaces')}
                      value={form.excludeNamespaces}
                      onChange={set('excludeNamespaces')}
                    />
                    <Text
                      label="Resources to include"
                      hint="For example pods,deployments. Empty means all."
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
                      hint="Only resources with these labels, for example app=web,tier in (a,b)."
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
                    <details className="rounded-md border border-control p-2">
                      <summary className="cursor-pointer text-sm font-medium">
                        More resource filters
                      </summary>
                      <div className="mt-2 flex flex-col gap-3">
                        <Text
                          label="Cluster-scoped resources to include"
                          error={shown('includeClusterScopedResources')}
                          value={form.includeClusterScopedResources}
                          onChange={set('includeClusterScopedResources')}
                          disabled={limited}
                        />
                        <Text
                          label="Cluster-scoped resources to exclude"
                          value={form.excludeClusterScopedResources}
                          onChange={set('excludeClusterScopedResources')}
                          disabled={limited}
                        />
                        <Text
                          label="Namespaced resources to include"
                          value={form.includeNamespaceScopedResources}
                          onChange={set('includeNamespaceScopedResources')}
                        />
                        <Text
                          label="Namespaced resources to exclude"
                          value={form.excludeNamespaceScopedResources}
                          onChange={set('excludeNamespaceScopedResources')}
                        />
                      </div>
                    </details>
                  </>
                )}

                {step === 1 && (
                  <>
                    <Select
                      label="Storage location"
                      hint="Where the backup is kept."
                      value={form.storageLocation}
                      onChange={set('storageLocation')}
                      options={locationOptions(backupLocations.data, 'Velero’s default')}
                    />
                    <Text
                      label="Volume snapshot locations"
                      hint={
                        snapshotLocations.data !== undefined &&
                        snapshotLocations.data.items.length > 0
                          ? `Comma-separated. Available: ${snapshotLocations.data.items.map((l) => l.name).join(', ')}.`
                          : 'Comma-separated.'
                      }
                      error={shown('snapshotLocations')}
                      value={form.snapshotLocations}
                      onChange={set('snapshotLocations')}
                    />
                    <Select
                      label="Snapshot volumes"
                      value={form.snapshotVolumes}
                      onChange={(v) => {
                        set('snapshotVolumes')(v as Tri);
                      }}
                      options={TRI}
                    />
                    <Select
                      label="Back up volumes with the file-system backup by default"
                      value={form.defaultVolumesToFsBackup}
                      onChange={(v) => {
                        set('defaultVolumesToFsBackup')(v as Tri);
                      }}
                      options={TRI}
                    />
                    <Select
                      label="Move snapshot data to the backup storage"
                      value={form.snapshotMoveData}
                      onChange={(v) => {
                        set('snapshotMoveData')(v as Tri);
                      }}
                      options={TRI}
                    />
                    <Text
                      label="Data mover"
                      hint="Empty means Velero’s built-in data mover."
                      value={form.dataMover}
                      onChange={set('dataMover')}
                    />
                  </>
                )}

                {step === 2 && (
                  <>
                    <Text
                      label="Keep for"
                      hint="A duration such as 720h (30 days). Empty means Velero’s default."
                      error={shown('ttl')}
                      value={form.ttl}
                      onChange={set('ttl')}
                    />
                    <Text
                      label="Item operation timeout"
                      error={shown('itemOperationTimeout')}
                      value={form.itemOperationTimeout}
                      onChange={set('itemOperationTimeout')}
                    />
                    <Text
                      label="CSI snapshot timeout"
                      error={shown('csiSnapshotTimeout')}
                      value={form.csiSnapshotTimeout}
                      onChange={set('csiSnapshotTimeout')}
                    />
                    <Text
                      label="Resource policy ConfigMap"
                      hint="The name of a ConfigMap in Velero’s namespace."
                      error={shown('resourcePolicy')}
                      value={form.resourcePolicy}
                      onChange={set('resourcePolicy')}
                    />
                    <Text
                      label="Ordered resources"
                      hint="For example pods=shop/a,shop/b;persistentvolumes=pv1"
                      error={shown('orderedResources')}
                      value={form.orderedResources}
                      onChange={set('orderedResources')}
                    />
                    <Text
                      label="Parallel file uploads"
                      hint="1 to 64. Empty means Velero’s default."
                      error={shown('parallelFilesUpload')}
                      value={form.parallelFilesUpload}
                      onChange={set('parallelFilesUpload')}
                    />
                    <Area
                      label="Advanced settings (JSON)"
                      hint={
                        mayUseAdvanced
                          ? 'Merged onto the backup spec and checked against Velero’s. For example hooks.'
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
                    <p className="text-sm text-muted-foreground">
                      Check what will be sent. Nothing happens until you create the backup.
                    </p>
                    <pre
                      aria-label="Request"
                      className="max-h-80 overflow-auto rounded-md border border-control bg-background p-3 text-xs"
                    >
                      {JSON.stringify(toBody(form), null, 2)}
                    </pre>
                    {[0, 1, 2].some(stepHasErrors) && (
                      <ErrorNote message="Some settings need attention. Use Back to fix them." />
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
                    <Button variant="primary" onClick={submit} disabled={create.isPending}>
                      {create.isPending ? 'Creating…' : 'Create backup'}
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
