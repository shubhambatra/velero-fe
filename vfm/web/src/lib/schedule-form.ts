/**
 * The schedule form: a name, a cron expression, and a backup template (PLAN.md §6, §11.1).
 * The template is the backup wizard's own form, so a schedule makes exactly the backup the
 * backup wizard would. Pure and free of React, like `backup-form.ts`, which supplies the
 * rules for everything inside the template.
 *
 * Validation mirrors `server/src/schedules/schedule-request.ts`; the server is the authority.
 */
import {
  emptyForm,
  OBJECT_NAME,
  selectorText,
  shellQuote,
  toBody as templateBody,
  toCli as templateCli,
  validate as validateTemplate,
  type BackupForm,
  type ClusterScoped,
  type Context,
  type Errors as TemplateErrors,
  type Tri,
} from './backup-form';
import { parseCron } from './cron';

/** A backup name is `<schedule>-<14-digit timestamp>` and must fit a 63-character label. */
export const MAX_SCHEDULE_NAME = 48;

export interface ScheduleForm {
  name: string;
  cron: string;
  paused: boolean;
  skipImmediately: Tri;
  useOwnerReferences: Tri;
  /** `advanced` here is merged onto the template, as the API's top-level `advancedSpec`. */
  template: BackupForm;
  /**
   * Template settings the form has no input for. An update replaces the whole spec, so
   * what an existing schedule already says is carried through rather than lost.
   */
  carried: { metadataLabels?: Record<string, string>; volumeGroupSnapshotLabelKey?: string };
  /** The existing template has hooks. They are kept as they are (see the update endpoint). */
  hasHooks: boolean;
}

export function emptyScheduleForm(limitedToNamespaces: boolean): ScheduleForm {
  return {
    name: '',
    cron: '0 2 * * *',
    paused: false,
    skipImmediately: 'default',
    useOwnerReferences: 'default',
    template: emptyForm(limitedToNamespaces),
    carried: {},
    hasHooks: false,
  };
}

// ---------------------------------------------------------------------------
// Validation

export interface ScheduleErrors {
  name?: string;
  cron?: string;
  template: TemplateErrors;
}

export function validateSchedule(
  form: ScheduleForm,
  ctx: Context & { editing: boolean },
): ScheduleErrors {
  const e: ScheduleErrors = { template: validateTemplate({ ...form.template, name: '' }, ctx) };
  if (!ctx.editing) {
    if (form.name === '') e.name = 'A schedule needs a name.';
    else if (form.name.length > MAX_SCHEDULE_NAME || !OBJECT_NAME.test(form.name)) {
      e.name = `Use lower-case letters, digits, "-" and ".", up to ${MAX_SCHEDULE_NAME.toString()} characters (the backups it makes are named after it).`;
    }
  }
  const cron = parseCron(form.cron);
  if ('error' in cron) e.cron = cron.error;
  return e;
}

export const hasErrors = (e: ScheduleErrors): boolean =>
  e.name !== undefined || e.cron !== undefined || Object.keys(e.template).length > 0;

/** Which step each part belongs to: 0 is "When", 1–3 are the template's three steps. */
export const SCHEDULE_STEPS = [
  'When',
  'What to back up',
  'Storage and volumes',
  'Options',
  'Review',
];

export function stepOfError(
  e: ScheduleErrors,
  templateStepFields: Record<number, (keyof BackupForm)[]>,
): number[] {
  const steps: number[] = [];
  if (e.name !== undefined || e.cron !== undefined) steps.push(0);
  for (const [n, keys] of Object.entries(templateStepFields)) {
    if (keys.some((k) => e.template[k] !== undefined)) steps.push(Number(n) + 1);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// The API body

const tri = (v: Tri): boolean | undefined => (v === 'default' ? undefined : v === 'yes');

/** The body of `POST …/schedules` (with `name`) or `PUT …/schedules/{name}` (without). */
export function toScheduleBody(form: ScheduleForm, creating: boolean): Record<string, unknown> {
  // `name` is empty, so the backup body leaves it out.
  const { advancedSpec, ...template } = templateBody({ ...form.template, name: '' });
  const merged: Record<string, unknown> = { ...template };
  for (const [key, value] of Object.entries(form.carried)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  const body: Record<string, unknown> = {};
  if (creating) body.name = form.name.trim();
  body.schedule = form.cron.trim();
  body.template = merged;
  if (form.paused) body.paused = true;
  const skip = tri(form.skipImmediately);
  if (skip !== undefined) body.skipImmediately = skip;
  const owner = tri(form.useOwnerReferences);
  if (owner !== undefined) body.useOwnerReferencesInBackup = owner;
  if (advancedSpec !== undefined) body.advancedSpec = advancedSpec;
  return body;
}

// ---------------------------------------------------------------------------
// The CLI equivalent

export interface CliPreview {
  command: string;
  notes: string[];
}

/** The `velero schedule create` command that makes the same schedule. */
export function toScheduleCli(form: ScheduleForm): CliPreview {
  const backup = templateCli({ ...form.template, name: '' });
  const flags = backup.command.replace(/^velero backup create <name>\s*/, '');
  const parts = [
    'velero schedule create',
    form.name.trim() === '' ? '<name>' : shellQuote(form.name.trim()),
    '--schedule',
    shellQuote(form.cron.trim()),
  ];
  if (form.paused) parts.push('--paused');
  if (form.skipImmediately !== 'default') {
    parts.push(`--skip-immediately=${form.skipImmediately === 'yes' ? 'true' : 'false'}`);
  }
  if (form.useOwnerReferences !== 'default') {
    parts.push(
      `--use-owner-references-in-backup=${form.useOwnerReferences === 'yes' ? 'true' : 'false'}`,
    );
  }
  if (flags !== '') parts.push(flags);
  return { command: parts.join(' '), notes: backup.notes };
}

// ---------------------------------------------------------------------------
// From an existing schedule

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(',') : '';
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const triOf = (v: unknown): Tri => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : 'default');
const stringMap = (v: unknown): Record<string, string> =>
  isRecord(v)
    ? Object.fromEntries(
        Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'),
      )
    : {};

/** The form for a schedule's stored `spec`, so it can be edited. */
export function fromSpec(spec: unknown, name: string): ScheduleForm {
  const s = isRecord(spec) ? spec : {};
  const t = isRecord(s.template) ? s.template : {};
  const clusterScoped: ClusterScoped =
    typeof t.includeClusterResources === 'boolean'
      ? t.includeClusterResources
        ? 'yes'
        : 'no'
      : 'auto';
  const ordered = Object.entries(stringMap(t.orderedResources))
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  const selector = (v: unknown): string => (isRecord(v) ? selectorText(v) : '');
  const template: BackupForm = {
    ...emptyForm(false),
    namespaces: strings(t.includedNamespaces),
    excludeNamespaces: strings(t.excludedNamespaces),
    includeResources: strings(t.includedResources),
    excludeResources: strings(t.excludedResources),
    clusterScoped,
    includeClusterScopedResources: strings(t.includedClusterScopedResources),
    excludeClusterScopedResources: strings(t.excludedClusterScopedResources),
    includeNamespaceScopedResources: strings(t.includedNamespaceScopedResources),
    excludeNamespaceScopedResources: strings(t.excludedNamespaceScopedResources),
    selector: selector(t.labelSelector),
    orSelectors: Array.isArray(t.orLabelSelectors)
      ? t.orLabelSelectors.map(selector).join('\n')
      : '',
    storageLocation: text(t.storageLocation),
    snapshotLocations: strings(t.volumeSnapshotLocations),
    snapshotVolumes: triOf(t.snapshotVolumes),
    defaultVolumesToFsBackup: triOf(t.defaultVolumesToFsBackup),
    snapshotMoveData: triOf(t.snapshotMoveData),
    dataMover: text(t.datamover),
    ttl: text(t.ttl),
    itemOperationTimeout: text(t.itemOperationTimeout),
    csiSnapshotTimeout: text(t.csiSnapshotTimeout),
    resourcePolicy: isRecord(t.resourcePolicy) ? text(t.resourcePolicy.name) : '',
    orderedResources: ordered,
    parallelFilesUpload:
      isRecord(t.uploaderConfig) && typeof t.uploaderConfig.parallelFilesUpload === 'number'
        ? t.uploaderConfig.parallelFilesUpload.toString()
        : '',
    advanced: '',
  };
  const labels = stringMap(isRecord(t.metadata) ? t.metadata.labels : undefined);
  const carried: ScheduleForm['carried'] = {};
  if (Object.keys(labels).length > 0) carried.metadataLabels = labels;
  if (typeof t.volumeGroupSnapshotLabelKey === 'string' && t.volumeGroupSnapshotLabelKey !== '') {
    carried.volumeGroupSnapshotLabelKey = t.volumeGroupSnapshotLabelKey;
  }
  return {
    name,
    cron: text(s.schedule),
    paused: s.paused === true,
    skipImmediately: triOf(s.skipImmediately),
    useOwnerReferences: triOf(s.useOwnerReferencesInBackup),
    template,
    carried,
    hasHooks: isRecord(t.hooks),
  };
}
