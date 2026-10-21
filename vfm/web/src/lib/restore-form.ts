import {
  DNS_LABEL,
  DURATION,
  list,
  OBJECT_NAME,
  parseSelector,
  selectorText,
  shellQuote,
  type ClusterScoped,
  type Tri,
} from './backup-form';

/**
 * The restore wizard's form: what is typed, whether it is valid, the API body it becomes,
 * the `velero restore create` command it is equivalent to and the impact summary
 * (PLAN.md §6, §11.1). Pure and free of React so each rule can be tested on its own.
 * Validation mirrors the server's; the server stays the authority.
 */

export type SourceKind = 'backup' | 'schedule';
export type Policy = 'default' | 'none' | 'update';

export interface RestoreForm {
  sourceKind: SourceKind;
  source: string;
  name: string;
  namespaces: string;
  excludeNamespaces: string;
  /** `source:target,source:target`, the form `--namespace-mappings` takes. */
  mapping: string;
  includeResources: string;
  excludeResources: string;
  clusterScoped: ClusterScoped;
  selector: string;
  orSelectors: string;
  existingResourcePolicy: Policy;
  restorePVs: Tri;
  preserveNodePorts: Tri;
  statusInclude: string;
  statusExclude: string;
  itemOperationTimeout: string;
  resourceModifier: string;
  writeSparseFiles: Tri;
  parallelFilesDownload: string;
  advanced: string;
}

export function emptyRestoreForm(limitedToNamespaces: boolean, source = ''): RestoreForm {
  return {
    sourceKind: 'backup',
    source,
    name: '',
    namespaces: '',
    excludeNamespaces: '',
    mapping: '',
    includeResources: '',
    excludeResources: '',
    clusterScoped: limitedToNamespaces ? 'no' : 'auto',
    selector: '',
    orSelectors: '',
    existingResourcePolicy: 'default',
    restorePVs: 'default',
    preserveNodePorts: 'default',
    statusInclude: '',
    statusExclude: '',
    itemOperationTimeout: '',
    resourceModifier: '',
    writeSparseFiles: 'default',
    parallelFilesDownload: '',
    advanced: '',
  };
}

// ---------------------------------------------------------------------------

/** `a:b,c:d` into `{ a: 'b', c: 'd' }`. */
export function parseMapping(text: string): { value: Record<string, string> } | { error: string } {
  const out: Record<string, string> = {};
  for (const part of list(text)) {
    const pieces = part.split(':').map((p) => p.trim());
    const [from, to] = pieces;
    if (pieces.length !== 2 || from === undefined || to === undefined) {
      return { error: `"${part}" should look like source:target` };
    }
    for (const ns of [from, to]) {
      if (ns.length > 63 || !DNS_LABEL.test(ns)) {
        return { error: `"${ns}" is not a namespace name` };
      }
    }
    if (Object.hasOwn(out, from)) {
      return { error: `"${from}" is mapped twice` };
    }
    out[from] = to;
  }
  return { value: out };
}

export type Errors = Partial<Record<keyof RestoreForm, string>>;

export interface Context {
  limitedToNamespaces: boolean;
  mayUseAdvanced: boolean;
  /** The cluster owner's policy forbids cluster-scoped restores (G-4); only "No" is accepted. */
  clusterScopedDenied?: boolean;
}

export function validate(form: RestoreForm, ctx: Context): Errors {
  const e: Errors = {};
  if (form.source.trim() === '') {
    e.source =
      form.sourceKind === 'backup'
        ? 'Choose the backup to restore.'
        : 'Choose the schedule to restore from.';
  } else if (!OBJECT_NAME.test(form.source.trim()) || form.source.trim().length > 63) {
    e.source = 'Not a valid name.';
  }
  if (form.name !== '' && (form.name.length > 63 || !OBJECT_NAME.test(form.name))) {
    e.name = 'Use lower-case letters, digits, "-" and ".", up to 63 characters.';
  }

  const included = list(form.namespaces);
  const bad = [...included, ...list(form.excludeNamespaces)].find(
    (n) => n !== '*' && (n.length > 63 || !DNS_LABEL.test(n)),
  );
  if (bad !== undefined) {
    e.namespaces = `"${bad}" is not a namespace name. Patterns such as "dev*" are not accepted.`;
  }

  if (form.mapping.trim() !== '') {
    const parsed = parseMapping(form.mapping);
    if ('error' in parsed) {
      e.mapping = parsed.error;
    } else if (included.length > 0 && !included.includes('*')) {
      const unused = Object.keys(parsed.value).find((from) => !included.includes(from));
      if (unused !== undefined) {
        e.mapping = `"${unused}" is not among the namespaces to restore, so this mapping would do nothing.`;
      }
    }
  }

  if (ctx.limitedToNamespaces) {
    if (included.length === 0 || included.includes('*')) {
      e.namespaces ??= 'Your access covers only some namespaces: name each namespace to restore.';
    }
    if (form.clusterScoped !== 'no') {
      e.clusterScoped = 'Your access does not include cluster-scoped resources: choose "No".';
    }
  }

  if (ctx.clusterScopedDenied === true && form.clusterScoped !== 'no') {
    e.clusterScoped ??=
      'The owner of this cluster does not allow restoring cluster-scoped resources: choose "No".';
  }

  for (const key of [
    'includeResources',
    'excludeResources',
    'statusInclude',
    'statusExclude',
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
  if (form.resourceModifier !== '' && !OBJECT_NAME.test(form.resourceModifier)) {
    e.resourceModifier = 'Not a valid ConfigMap name.';
  }
  const t = form.itemOperationTimeout.trim();
  if (t !== '') {
    if (!DURATION.test(t)) e.itemOperationTimeout = 'A duration such as "4h" or "30m".';
    else if (!/[1-9]/.test(t.replace(/\.0+/g, '')))
      e.itemOperationTimeout = 'Must be greater than zero.';
  }
  if (form.parallelFilesDownload.trim() !== '') {
    const n = Number(form.parallelFilesDownload);
    if (!Number.isInteger(n) || n < 1 || n > 64)
      e.parallelFilesDownload = 'A whole number from 1 to 64.';
  }
  if (form.advanced.trim() !== '') {
    if (!ctx.mayUseAdvanced) {
      e.advanced = 'Only administrators of the whole cluster may use this.';
    } else {
      try {
        const v: unknown = JSON.parse(form.advanced);
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          e.advanced = 'Must be a JSON object.';
      } catch {
        e.advanced = 'Not valid JSON.';
      }
    }
  }
  return e;
}

export const STEP_FIELDS: Record<number, (keyof RestoreForm)[]> = {
  0: ['sourceKind', 'source', 'name'],
  1: [
    'namespaces',
    'excludeNamespaces',
    'mapping',
    'includeResources',
    'excludeResources',
    'clusterScoped',
    'selector',
    'orSelectors',
  ],
  2: [
    'existingResourcePolicy',
    'restorePVs',
    'preserveNodePorts',
    'statusInclude',
    'statusExclude',
    'itemOperationTimeout',
    'resourceModifier',
    'writeSparseFiles',
    'parallelFilesDownload',
    'advanced',
  ],
};

// ---------------------------------------------------------------------------
// The API body

const tri = (v: Tri): boolean | undefined => (v === 'default' ? undefined : v === 'yes');

export function toBody(form: RestoreForm): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) {
      body[key] = value;
    }
  };
  put(form.sourceKind === 'backup' ? 'backupName' : 'scheduleName', form.source.trim());
  put('name', form.name.trim());
  put('includedNamespaces', list(form.namespaces));
  put('excludedNamespaces', list(form.excludeNamespaces));
  if (form.mapping.trim() !== '') {
    const parsed = parseMapping(form.mapping);
    if ('value' in parsed && Object.keys(parsed.value).length > 0)
      body.namespaceMapping = parsed.value;
  }
  put('includedResources', list(form.includeResources));
  put('excludedResources', list(form.excludeResources));
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
  if (form.existingResourcePolicy !== 'default')
    body.existingResourcePolicy = form.existingResourcePolicy;
  put('restorePVs', tri(form.restorePVs));
  put('preserveNodePorts', tri(form.preserveNodePorts));
  const si = list(form.statusInclude);
  const se = list(form.statusExclude);
  if (si.length > 0 || se.length > 0) {
    body.restoreStatus = {
      ...(si.length > 0 ? { includedResources: si } : {}),
      ...(se.length > 0 ? { excludedResources: se } : {}),
    };
  }
  put('itemOperationTimeout', form.itemOperationTimeout.trim());
  put('resourceModifier', form.resourceModifier.trim());
  put('writeSparseFiles', tri(form.writeSparseFiles));
  if (form.parallelFilesDownload.trim() !== '')
    body.parallelFilesDownload = Number(form.parallelFilesDownload);
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

export interface CliPreview {
  command: string;
  notes: string[];
}

export function toCli(form: RestoreForm): CliPreview {
  const parts: string[] = ['velero', 'restore', 'create'];
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

  const sourceFlag = form.sourceKind === 'backup' ? '--from-backup' : '--from-schedule';
  parts.push(sourceFlag, form.source.trim() === '' ? '<source>' : shellQuote(form.source.trim()));
  flagList('include-namespaces', form.namespaces);
  flagList('exclude-namespaces', form.excludeNamespaces);
  const mapping = parseMapping(form.mapping);
  if ('value' in mapping) {
    flag(
      'namespace-mappings',
      Object.entries(mapping.value)
        .map(([a, b]) => `${a}:${b}`)
        .join(','),
    );
  }
  flagList('include-resources', form.includeResources);
  flagList('exclude-resources', form.excludeResources);
  if (form.clusterScoped !== 'auto') {
    parts.push(`--include-cluster-resources=${form.clusterScoped === 'yes' ? 'true' : 'false'}`);
  }
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
  if (form.existingResourcePolicy !== 'default')
    flag('existing-resource-policy', form.existingResourcePolicy);
  bool('restore-volumes', form.restorePVs);
  bool('preserve-nodeports', form.preserveNodePorts);
  flagList('status-include-resources', form.statusInclude);
  flagList('status-exclude-resources', form.statusExclude);
  flag('item-operation-timeout', form.itemOperationTimeout.trim());
  flag('resource-modifier-configmap', form.resourceModifier.trim());
  bool('write-sparse-files', form.writeSparseFiles);
  flag('parallel-files-download', form.parallelFilesDownload.trim());

  const notes: string[] = [];
  if (form.advanced.trim() !== '') {
    notes.push(
      'The advanced settings have no flags: create the restore from a manifest (kubectl apply) to get them.',
    );
  }
  return { command: parts.join(' '), notes };
}

// ---------------------------------------------------------------------------
// The impact summary

/** A namespace the restore would write into and where its data comes from; `null` when the restore covers all namespaces. */
export interface Target {
  source: string;
  target: string;
}

export function impactTargets(form: RestoreForm): Target[] | null {
  const included = list(form.namespaces);
  if (included.length === 0 || included.includes('*')) return null;
  const mapping = parseMapping(form.mapping);
  const map = 'value' in mapping ? mapping.value : {};
  return included.map((source) => ({
    source,
    target: Object.hasOwn(map, source) ? (map[source] ?? source) : source,
  }));
}

export interface NamespaceState {
  name: string;
  exists: boolean;
  terminating: boolean;
}

export type Effect = 'created' | 'merged' | 'updated' | 'blocked' | 'unknown';

export interface ImpactRow extends Target {
  inPlace: boolean;
  effect: Effect;
  note: string;
}

/**
 * What the restore will do in each target namespace, given what the cluster reports.
 * `report` is `undefined` until the agent has answered.
 */
export function impactRows(
  form: RestoreForm,
  report: NamespaceState[] | undefined,
): ImpactRow[] | null {
  const targets = impactTargets(form);
  if (targets === null) return null;
  return targets.map((t) => {
    const inPlace = t.source === t.target;
    const state = report?.find((r) => r.name === t.target);
    if (state === undefined) {
      return { ...t, inPlace, effect: 'unknown', note: 'Not known yet.' };
    }
    if (!state.exists) {
      return { ...t, inPlace, effect: 'created', note: 'Does not exist; it will be created.' };
    }
    if (state.terminating) {
      return {
        ...t,
        inPlace,
        effect: 'blocked',
        note: 'Is being deleted; the restore into it will fail until it is gone.',
      };
    }
    return form.existingResourcePolicy === 'update'
      ? {
          ...t,
          inPlace,
          effect: 'updated',
          note: 'Exists; resources that exist in it are updated to match the backup.',
        }
      : {
          ...t,
          inPlace,
          effect: 'merged',
          note: 'Exists; resources that exist in it are left as they are and missing ones are added.',
        };
  });
}
