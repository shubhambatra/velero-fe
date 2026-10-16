import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { ClusterShell } from '@/components/cluster-shell';
import { useToasts } from '@/components/toast-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { useAccess } from '@/lib/access';
import {
  emptyForm,
  STEP_FIELDS,
  toBody,
  toCli,
  validate,
  type BackupForm,
} from '@/lib/backup-form';
import { api, errorMessage } from '@/lib/client';
import { cn } from '@/lib/cn';
import { TemplateFields, type NamedList } from '@/components/backup-fields';
import { CopyButton } from '@/components/form-fields';

const STEPS = ['What to back up', 'Storage and volumes', 'Options', 'Review'] as const;

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
            <CardDescription>{access.why('backup:create')}</CardDescription>
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
                {step <= 2 && (
                  <TemplateFields
                    step={step as 0 | 1 | 2}
                    form={form}
                    setForm={setForm}
                    shown={shown}
                    limited={limited}
                    mayUseAdvanced={mayUseAdvanced}
                    backupLocations={backupLocations.data}
                    snapshotLocations={snapshotLocations.data}
                    withName
                    advancedTarget="backup spec"
                  />
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
