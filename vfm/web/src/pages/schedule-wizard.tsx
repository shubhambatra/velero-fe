import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { TemplateFields, type NamedList } from '@/components/backup-fields';
import { ClusterShell } from '@/components/cluster-shell';
import { CronBuilder } from '@/components/cron-builder';
import { CopyButton, Select, Text } from '@/components/form-fields';
import { useToasts } from '@/components/toast-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorNote } from '@/components/ui/field';
import { useAccess } from '@/lib/access';
import { STEP_FIELDS, type BackupForm, type Tri } from '@/lib/backup-form';
import { api, errorMessage } from '@/lib/client';
import { cn } from '@/lib/cn';
import type { Detail, ScheduleRow } from '@/lib/resources';
import {
  emptyScheduleForm,
  fromSpec,
  hasErrors,
  MAX_SCHEDULE_NAME,
  SCHEDULE_STEPS,
  stepOfError,
  toScheduleBody,
  toScheduleCli,
  validateSchedule,
  type ScheduleForm,
} from '@/lib/schedule-form';

const TRI: { value: Tri; label: string }[] = [
  { value: 'default', label: 'Velero’s default' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const LAST = SCHEDULE_STEPS.length - 1;

/**
 * Creates a schedule, or changes an existing one when `name` is given (PLAN.md §6, §11.1).
 * What the schedule backs up is the backup wizard's own set of fields.
 */
export function ScheduleWizardPage({
  orgId,
  clusterId,
  name,
}: {
  orgId: string;
  clusterId: string;
  /** The schedule being edited; absent when creating. */
  name?: string;
}): ReactElement {
  const editing = name !== undefined;
  const access = useAccess(orgId, clusterId);
  const writeLevel = access.level('schedule:write');
  const limited = writeLevel === 'scoped';
  const mayUseAdvanced = access.level('advanced:write') === 'cluster';

  const [form, setForm] = useState<ScheduleForm>(() => ({
    ...emptyScheduleForm(false),
    name: name ?? '',
  }));
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState<ReadonlySet<number>>(new Set());
  const [adjusted, setAdjusted] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // Editing starts from what the schedule says now, once.
  const existing = useQuery({
    enabled: editing,
    queryKey: ['org', orgId, 'cluster', clusterId, 'schedule-edit', name],
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      api<Detail<ScheduleRow>>(
        `/orgs/${orgId}/clusters/${clusterId}/schedules/${encodeURIComponent(name ?? '')}`,
        { signal },
      ),
  });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (editing && existing.data !== undefined && !loaded) {
      setForm(fromSpec(existing.data.spec, name));
      setLoaded(true);
      setAdjusted(true);
    }
  }, [editing, existing.data, loaded, name]);

  // A user limited to some namespaces starts from the only cluster-scoped setting that works for them.
  useEffect(() => {
    if (!editing && limited && !adjusted) {
      setForm((f) => ({ ...f, template: { ...f.template, clusterScoped: 'no' } }));
      setAdjusted(true);
    }
  }, [editing, limited, adjusted]);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const errors = validateSchedule(form, { limitedToNamespaces: limited, mayUseAdvanced, editing });
  const badSteps = stepOfError(errors, STEP_FIELDS);
  const stepHasErrors = (n: number): boolean => badSteps.includes(n);
  // Template fields live on steps 1–3; the template's own step numbers are 0–2.
  const shown = (key: keyof BackupForm): string | undefined => {
    const owner = Object.entries(STEP_FIELDS).find(([, keys]) => keys.includes(key));
    return owner !== undefined && (attempted.has(Number(owner[0]) + 1) || step === LAST)
      ? errors.template[key]
      : undefined;
  };
  const shownWhen = (key: 'name' | 'cron'): string | undefined =>
    attempted.has(0) || step === LAST ? errors[key] : undefined;

  const setTemplate = (update: (f: BackupForm) => BackupForm) => {
    setForm((f) => ({ ...f, template: update(f.template) }));
  };

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
  const save = useMutation({
    mutationFn: () =>
      api<{ id: string }>(
        editing
          ? `/orgs/${orgId}/clusters/${clusterId}/schedules/${encodeURIComponent(name)}`
          : `/orgs/${orgId}/clusters/${clusterId}/schedules`,
        { method: editing ? 'PUT' : 'POST', body: toScheduleBody(form, !editing) },
      ),
    onSuccess: (command) => {
      const label = editing ? name : form.name.trim();
      follow({
        orgId,
        clusterId,
        commandId: command.id,
        title: editing ? `Update schedule ${label}` : `Create schedule ${label}`,
      });
      void navigate({ to: '/clusters/$clusterId/schedules', params: { clusterId } });
    },
  });

  const next = () => {
    setAttempted((a) => new Set(a).add(step));
    if (!stepHasErrors(step)) setStep((s) => Math.min(LAST, s + 1));
  };
  const submit = () => {
    const firstBad = [0, 1, 2, 3].find(stepHasErrors);
    if (firstBad !== undefined) {
      setAttempted(new Set([0, 1, 2, 3, 4]));
      setStep(firstBad);
      return;
    }
    save.mutate();
  };

  const cli = toScheduleCli(form);
  const title = editing ? `Edit schedule ${name}` : 'Create a schedule';

  return (
    <ClusterShell
      orgId={orgId}
      clusterId={clusterId}
      tab="schedules"
      title={title}
      crumbs={
        <>
          {' / '}
          <Link to="/clusters/$clusterId/schedules" params={{ clusterId }} className="underline">
            Schedules
          </Link>
        </>
      }
    >
      {writeLevel === 'none' ? (
        <Card>
          <CardHeader>
            <CardTitle>{`You cannot ${editing ? 'change' : 'create'} schedules here`}</CardTitle>
            <CardDescription>{access.why('schedule:write')}</CardDescription>
          </CardHeader>
        </Card>
      ) : editing && existing.isError ? (
        <Card>
          <CardHeader>
            <CardTitle>This schedule could not be loaded</CardTitle>
            <CardDescription>
              It may have been deleted, or you may not be allowed to see it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ErrorNote message={errorMessage(existing.error)} />
          </CardContent>
        </Card>
      ) : editing && !loaded ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the schedule…
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <div className="flex flex-col gap-4">
            <ol aria-label="Steps" className="flex flex-wrap gap-2 text-sm">
              {SCHEDULE_STEPS.map((label, i) => (
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
                  {SCHEDULE_STEPS[step]}
                </h2>
                {limited && step === 1 && (
                  <CardDescription>
                    Your access covers only some namespaces, so every namespace to back up must be
                    named and cluster-scoped resources are left out.
                  </CardDescription>
                )}
                {editing && step === 0 && (
                  <CardDescription>
                    Saving replaces the schedule’s settings with this form. Backups it has already
                    made are not changed.
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {step === 0 && (
                  <>
                    {!editing && (
                      <Text
                        label="Name"
                        hint={`Up to ${MAX_SCHEDULE_NAME.toString()} characters. Its backups are named after it, followed by the time.`}
                        error={shownWhen('name')}
                        value={form.name}
                        onChange={(v) => {
                          setForm((f) => ({ ...f, name: v }));
                        }}
                      />
                    )}
                    <CronBuilder
                      value={form.cron}
                      error={shownWhen('cron')}
                      onChange={(cron) => {
                        setForm((f) => ({ ...f, cron }));
                      }}
                    />
                  </>
                )}

                {step >= 1 && step <= 3 && (
                  <TemplateFields
                    step={(step - 1) as 0 | 1 | 2}
                    form={form.template}
                    setForm={setTemplate}
                    shown={shown}
                    limited={limited}
                    mayUseAdvanced={mayUseAdvanced}
                    backupLocations={backupLocations.data}
                    snapshotLocations={snapshotLocations.data}
                    withName={false}
                    advancedTarget="backup template"
                  />
                )}

                {step === 3 && (
                  <>
                    <Select
                      label="Start paused"
                      hint="A paused schedule makes no backups until it is resumed."
                      value={form.paused ? 'yes' : 'no'}
                      onChange={(v) => {
                        setForm((f) => ({ ...f, paused: v === 'yes' }));
                      }}
                      options={[
                        { value: 'no', label: 'No' },
                        { value: 'yes', label: 'Yes' },
                      ]}
                    />
                    <Select
                      label="Skip the run that is already due"
                      hint="When the schedule is created, Velero normally makes a backup at once if one is due."
                      value={form.skipImmediately}
                      onChange={(v) => {
                        setForm((f) => ({ ...f, skipImmediately: v as Tri }));
                      }}
                      options={TRI}
                    />
                    <Select
                      label="Backups are owned by the schedule"
                      hint="With owner references, deleting the schedule deletes the backups it made."
                      value={form.useOwnerReferences}
                      onChange={(v) => {
                        setForm((f) => ({ ...f, useOwnerReferences: v as Tri }));
                      }}
                      options={TRI}
                    />
                    {form.hasHooks && (
                      <p className="text-sm text-muted-foreground">
                        This schedule has backup hooks. They are kept as they are; to change them,
                        use the advanced settings.
                      </p>
                    )}
                  </>
                )}

                {step === LAST && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {`Check what will be sent. Nothing happens until you ${editing ? 'save' : 'create'} the schedule.`}
                    </p>
                    <pre
                      aria-label="Request"
                      className="max-h-80 overflow-auto rounded-md border border-control bg-background p-3 text-xs"
                    >
                      {JSON.stringify(toScheduleBody(form, !editing), null, 2)}
                    </pre>
                    {hasErrors(errors) && (
                      <ErrorNote message="Some settings need attention. Use Back to fix them." />
                    )}
                    <ErrorNote message={save.isError ? errorMessage(save.error) : undefined} />
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
                  {step < LAST ? (
                    <Button variant="primary" onClick={next}>
                      Next
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={submit} disabled={save.isPending}>
                      {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create schedule'}
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
                <CardDescription>
                  {editing
                    ? 'The command that would create this schedule from scratch.'
                    : 'Updates as you fill in the form.'}
                </CardDescription>
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
