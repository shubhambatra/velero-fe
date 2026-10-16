/**
 * The backup wizard's form: what is typed, whether it is valid, the API body it
 * becomes and the `velero backup create` command it is equivalent to (PLAN.md §6,
 * §11.1). Pure and free of React so each rule can be tested on its own.
 *
 * Validation here mirrors the server's (`server/src/backups/backup-request.ts`); the
 * server stays the authority. The point is to say what is wrong next to the field
 * before anything is sent.
 */

export type Tri = 'default' | 'yes' | 'no';
export type ClusterScoped = 'auto' | 'no' | 'yes';

export interface BackupForm {
  name: string;
  namespaces: string;
  excludeNamespaces: string;
  includeResources: string;
  excludeResources: string;
  clusterScoped: ClusterScoped;
  includeClusterScopedResources: string;
  excludeClusterScopedResources: string;
  includeNamespaceScopedResources: string;
  excludeNamespaceScopedResources: string;
  selector: string;
  /** One selector per line; a resource matching any of them is included. */
  orSelectors: string;
  storageLocation: string;
  snapshotLocations: string;
  snapshotVolumes: Tri;
  defaultVolumesToFsBackup: Tri;
  snapshotMoveData: Tri;
  dataMover: string;
  ttl: string;
  itemOperationTimeout: string;
  csiSnapshotTimeout: string;
  resourcePolicy: string;
  orderedResources: string;
  parallelFilesUpload: string;
  /** A JSON object merged onto the spec (whole-cluster administrators only). */
  advanced: string;
}

/**
 * A new form. A user limited to some namespaces starts with cluster-scoped resources
 * switched off, the only setting the server accepts for them; everyone else starts
 * with Velero's own default.
 */
export function emptyForm(limitedToNamespaces: boolean): BackupForm {
  return {
    name: '',
    namespaces: '',
    excludeNamespaces: '',
    includeResources: '',
    excludeResources: '',
    clusterScoped: limitedToNamespaces ? 'no' : 'auto',
    includeClusterScopedResources: '',
    excludeClusterScopedResources: '',
    includeNamespaceScopedResources: '',
    excludeNamespaceScopedResources: '',
    selector: '',
    orSelectors: '',
    storageLocation: '',
    snapshotLocations: '',
    snapshotVolumes: 'default',
    defaultVolumesToFsBackup: 'default',
    snapshotMoveData: 'default',
    dataMover: '',
    ttl: '',
    itemOperationTimeout: '',
    csiSnapshotTimeout: '',
    resourcePolicy: '',
    orderedResources: '',
    parallelFilesUpload: '',
    advanced: '',
  };
}

// ---------------------------------------------------------------------------
// Parsing

export const list = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

export interface Selector {
  matchLabels?: Record<string, string>;
  matchExpressions?: {
    key: string;
    operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
    values?: string[];
  }[];
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

const KEY =
  /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;

/**
 * Parses a label selector the way `kubectl -l` reads one: `app=web,tier in (a,b),!legacy`.
 * Returns an error message for anything it cannot read.
 */
export function parseSelector(text: string): { selector: Selector } | { error: string } {
  const out: Selector = {};
  for (const term of splitTopLevel(text)) {
    let m: RegExpExecArray | null;
    if ((m = /^(\S+)\s+(in|notin)\s*\(([^)]*)\)$/i.exec(term))) {
      const values = list(m[3] ?? '');
      if (!KEY.test(m[1] ?? '') || values.length === 0 || !values.every((v) => VALUE.test(v))) {
        return { error: `"${term}" is not a valid set expression` };
      }
      (out.matchExpressions ??= []).push({
        key: m[1] ?? '',
        operator: (m[2] ?? '').toLowerCase() === 'in' ? 'In' : 'NotIn',
        values,
      });
    } else if ((m = /^([^=!\s]+)\s*(==|=|!=)\s*(.*)$/.exec(term))) {
      const [, key = '', op = '=', value = ''] = m;
      if (!KEY.test(key) || !VALUE.test(value)) {
        return { error: `"${term}" is not a valid label requirement` };
      }
      if (op === '!=') {
        (out.matchExpressions ??= []).push({ key, operator: 'NotIn', values: [value] });
      } else {
        (out.matchLabels ??= {})[key] = value;
      }
    } else if ((m = /^!\s*(\S+)$/.exec(term))) {
      if (!KEY.test(m[1] ?? '')) return { error: `"${term}" is not a valid label name` };
      (out.matchExpressions ??= []).push({ key: m[1] ?? '', operator: 'DoesNotExist' });
    } else if (KEY.test(term)) {
      (out.matchExpressions ??= []).push({ key: term, operator: 'Exists' });
    } else {
      return { error: `"${term}" is not a valid label requirement` };
    }
  }
  return { selector: out };
}

/** The selector back as text, in kubectl's form. */
export function selectorText(s: Selector): string {
  const terms: string[] = Object.entries(s.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`);
  for (const e of s.matchExpressions ?? []) {
    const values = (e.values ?? []).join(',');
    terms.push(
      e.operator === 'In'
        ? `${e.key} in (${values})`
        : e.operator === 'NotIn'
          ? `${e.key} notin (${values})`
          : e.operator === 'Exists'
            ? e.key
            : `!${e.key}`,
    );
  }
  return terms.join(',');
}

/** `pods=ns/a,ns/b;persistentvolumes=pv1` into `{ pods: 'ns/a,ns/b', ... }`. */
export function parseOrdered(text: string): { value: Record<string, string> } | { error: string } {
  const out: Record<string, string> = {};
  for (const part of text
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p !== '')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || eq === part.length - 1) {
      return { error: `"${part}" should look like pods=namespace/name,namespace/name` };
    }
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return { value: out };
}

// ---------------------------------------------------------------------------
// Validation

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const OBJECT_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const DURATION = /^(\d+(\.\d+)?(ms|s|m|h))+$/;

export type Errors = Partial<Record<keyof BackupForm, string>>;

export interface Context {
  /** The caller's backup:create reaches only some namespaces. */
  limitedToNamespaces: boolean;
  /** The caller may use the advanced field. */
  mayUseAdvanced: boolean;
}

export function validate(form: BackupForm, ctx: Context): Errors {
  const e: Errors = {};
  if (form.name !== '' && (form.name.length > 63 || !OBJECT_NAME.test(form.name))) {
    e.name = 'Use lower-case letters, digits, "-" and ".", up to 63 characters.';
  }

  const namespaces = list(form.namespaces);
  const badNamespace = [...namespaces, ...list(form.excludeNamespaces)].find(
    (n) => n !== '*' && (n.length > 63 || !DNS_LABEL.test(n)),
  );
  if (badNamespace !== undefined) {
    e.namespaces = `"${badNamespace}" is not a namespace name. Patterns such as "dev*" are not accepted.`;
  }
  if (ctx.limitedToNamespaces) {
    if (namespaces.length === 0 || namespaces.includes('*')) {
      e.namespaces ??= 'Your access covers only some namespaces: name each namespace to back up.';
    }
    if (form.clusterScoped !== 'no') {
      e.clusterScoped = 'Your access does not include cluster-scoped resources: choose "No".';
    } else if (list(form.includeClusterScopedResources).length > 0) {
      e.includeClusterScopedResources = 'Cluster-scoped resources are not available to you.';
    }
  }

  for (const key of [
    'includeResources',
    'excludeResources',
    'includeClusterScopedResources',
    'excludeClusterScopedResources',
    'includeNamespaceScopedResources',
    'excludeNamespaceScopedResources',
  ] as const) {
    if (list(form[key]).some((r) => r.length > 253)) e[key] = 'A resource name is too long.';
  }

  if (form.selector.trim() !== '') {
    const parsed = parseSelector(form.selector);
    if ('error' in parsed) e.selector = parsed.error;
  }
  for (const line of form.orSelectors
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')) {
    const parsed = parseSelector(line);
    if ('error' in parsed) {
      e.orSelectors = parsed.error;
      break;
    }
  }

  for (const key of ['storageLocation'] as const) {
    if (form[key] !== '' && !OBJECT_NAME.test(form[key])) e[key] = 'Not a valid name.';
  }
  if (list(form.snapshotLocations).some((n) => !OBJECT_NAME.test(n))) {
    e.snapshotLocations = 'Not a list of valid names.';
  }
  if (form.resourcePolicy !== '' && !OBJECT_NAME.test(form.resourcePolicy)) {
    e.resourcePolicy = 'Not a valid ConfigMap name.';
  }

  for (const key of ['ttl', 'itemOperationTimeout', 'csiSnapshotTimeout'] as const) {
    const v = form[key].trim();
    if (v === '') continue;
    if (!DURATION.test(v)) e[key] = 'A duration such as "720h", "30m" or "1h30m".';
    else if (!/[1-9]/.test(v.replace(/\.0+/g, ''))) e[key] = 'Must be greater than zero.';
  }

  if (form.orderedResources.trim() !== '') {
    const parsed = parseOrdered(form.orderedResources);
    if ('error' in parsed) e.orderedResources = parsed.error;
  }
  if (form.parallelFilesUpload.trim() !== '') {
    const n = Number(form.parallelFilesUpload);
    if (!Number.isInteger(n) || n < 1 || n > 64)
      e.parallelFilesUpload = 'A whole number from 1 to 64.';
  }

  if (form.advanced.trim() !== '') {
    if (!ctx.mayUseAdvanced) {
      e.advanced = 'Only administrators of the whole cluster may use this.';
    } else {
      try {
        const v: unknown = JSON.parse(form.advanced);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          e.advanced = 'Must be a JSON object.';
        }
      } catch {
        e.advanced = 'Not valid JSON.';
      }
    }
  }
  return e;
}

/** Which step each field belongs to, so "Next" can point at the step with the problem. */
export const STEP_FIELDS: Record<number, (keyof BackupForm)[]> = {
  0: [
    'name',
    'namespaces',
    'excludeNamespaces',
    'includeResources',
    'excludeResources',
    'clusterScoped',
    'includeClusterScopedResources',
    'excludeClusterScopedResources',
    'includeNamespaceScopedResources',
    'excludeNamespaceScopedResources',
    'selector',
    'orSelectors',
  ],
  1: [
    'storageLocation',
    'snapshotLocations',
    'snapshotVolumes',
    'defaultVolumesToFsBackup',
    'snapshotMoveData',
    'dataMover',
  ],
  2: [
    'ttl',
    'itemOperationTimeout',
    'csiSnapshotTimeout',
    'resourcePolicy',
    'orderedResources',
    'parallelFilesUpload',
    'advanced',
  ],
};

// ---------------------------------------------------------------------------
// The API body

const tri = (v: Tri): boolean | undefined => (v === 'default' ? undefined : v === 'yes');

/** The body of `POST …/backups`. Only what was set is sent, so Velero's defaults apply to the rest. */
export function toBody(form: BackupForm): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) {
      body[key] = value;
    }
  };
  put('name', form.name.trim());
  put('includedNamespaces', list(form.namespaces));
  put('excludedNamespaces', list(form.excludeNamespaces));
  put('includedResources', list(form.includeResources));
  put('excludedResources', list(form.excludeResources));
  put('includedClusterScopedResources', list(form.includeClusterScopedResources));
  put('excludedClusterScopedResources', list(form.excludeClusterScopedResources));
  put('includedNamespaceScopedResources', list(form.includeNamespaceScopedResources));
  put('excludedNamespaceScopedResources', list(form.excludeNamespaceScopedResources));
  if (form.clusterScoped !== 'auto') body.includeClusterResources = form.clusterScoped === 'yes';
  if (form.selector.trim() !== '') {
    const parsed = parseSelector(form.selector);
    if ('selector' in parsed) put('labelSelector', parsed.selector);
  }
  const ors = form.orSelectors
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .flatMap((l) => {
      const parsed = parseSelector(l);
      return 'selector' in parsed ? [parsed.selector] : [];
    });
  put('orLabelSelectors', ors);
  put('storageLocation', form.storageLocation.trim());
  put('volumeSnapshotLocations', list(form.snapshotLocations));
  put('snapshotVolumes', tri(form.snapshotVolumes));
  put('defaultVolumesToFsBackup', tri(form.defaultVolumesToFsBackup));
  put('snapshotMoveData', tri(form.snapshotMoveData));
  put('dataMover', form.dataMover.trim());
  put('ttl', form.ttl.trim());
  put('itemOperationTimeout', form.itemOperationTimeout.trim());
  put('csiSnapshotTimeout', form.csiSnapshotTimeout.trim());
  put('resourcePolicy', form.resourcePolicy.trim());
  if (form.orderedResources.trim() !== '') {
    const parsed = parseOrdered(form.orderedResources);
    if ('value' in parsed) put('orderedResources', parsed.value);
  }
  if (form.parallelFilesUpload.trim() !== '')
    put('parallelFilesUpload', Number(form.parallelFilesUpload));
  if (form.advanced.trim() !== '') {
    try {
      put('advancedSpec', JSON.parse(form.advanced) as unknown);
    } catch {
      // validate() reports it
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// The CLI equivalent

/** Quotes a word for a POSIX shell only when it needs it. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface CliPreview {
  command: string;
  /** Things set in the form that `velero backup create` has no flag for. */
  notes: string[];
}

/** The `velero backup create` command that makes the same backup. */
export function toCli(form: BackupForm): CliPreview {
  const parts: string[] = ['velero', 'backup', 'create'];
  parts.push(form.name.trim() === '' ? '<name>' : shellQuote(form.name.trim()));
  const flag = (name: string, value: string) => {
    if (value !== '') parts.push(`--${name}`, shellQuote(value));
  };
  const flagList = (name: string, value: string) => {
    flag(name, list(value).join(','));
  };
  const bool = (name: string, v: Tri) => {
    if (v !== 'default') parts.push(`--${name}=${v === 'yes' ? 'true' : 'false'}`);
  };

  flagList('include-namespaces', form.namespaces);
  flagList('exclude-namespaces', form.excludeNamespaces);
  flagList('include-resources', form.includeResources);
  flagList('exclude-resources', form.excludeResources);
  if (form.clusterScoped !== 'auto') {
    parts.push(`--include-cluster-resources=${form.clusterScoped === 'yes' ? 'true' : 'false'}`);
  }
  flagList('include-cluster-scoped-resources', form.includeClusterScopedResources);
  flagList('exclude-cluster-scoped-resources', form.excludeClusterScopedResources);
  flagList('include-namespace-scoped-resources', form.includeNamespaceScopedResources);
  flagList('exclude-namespace-scoped-resources', form.excludeNamespaceScopedResources);
  if (form.selector.trim() !== '') {
    const parsed = parseSelector(form.selector);
    flag('selector', 'selector' in parsed ? selectorText(parsed.selector) : form.selector.trim());
  }
  const ors = form.orSelectors
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (ors.length > 0) {
    flag(
      'or-selector',
      ors
        .map((l) => {
          const parsed = parseSelector(l);
          return 'selector' in parsed ? selectorText(parsed.selector) : l;
        })
        .join(' or '),
    );
  }
  flag('ttl', form.ttl.trim());
  flag('storage-location', form.storageLocation.trim());
  flagList('volume-snapshot-locations', form.snapshotLocations);
  bool('snapshot-volumes', form.snapshotVolumes);
  bool('default-volumes-to-fs-backup', form.defaultVolumesToFsBackup);
  bool('snapshot-move-data', form.snapshotMoveData);
  flag('data-mover', form.dataMover.trim());
  flag('item-operation-timeout', form.itemOperationTimeout.trim());
  flag('csi-snapshot-timeout', form.csiSnapshotTimeout.trim());
  flag('resource-policies-configmap', form.resourcePolicy.trim());
  flag('ordered-resources', form.orderedResources.trim());
  flag('parallel-files-upload', form.parallelFilesUpload.trim());

  const notes: string[] = [];
  if (form.advanced.trim() !== '') {
    notes.push(
      'The advanced settings have no flags: create the backup from a manifest (kubectl apply) to get them.',
    );
  }
  return { command: parts.join(' '), notes };
}
