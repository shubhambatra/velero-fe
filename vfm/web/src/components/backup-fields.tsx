import type { ReactElement } from 'react';

import { Area, Select, Text } from '@/components/form-fields';
import type { BackupForm, ClusterScoped, Tri } from '@/lib/backup-form';

export interface NamedList {
  items: { name: string; isDefault?: boolean }[];
}

const TRI: { value: Tri; label: string }[] = [
  { value: 'default', label: 'Velero’s default' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const locationOptions = (list: NamedList | undefined, none: string) => [
  { value: '', label: none },
  ...(list?.items ?? []).map((l) => ({
    value: l.name,
    label: l.isDefault === true ? `${l.name} (default)` : l.name,
  })),
];

export interface TemplateFieldsProps {
  /** 0: what to back up, 1: storage and volumes, 2: options. */
  step: 0 | 1 | 2;
  form: BackupForm;
  setForm: (update: (form: BackupForm) => BackupForm) => void;
  /** The error to show next to a field, once its step has been tried. */
  shown: (key: keyof BackupForm) => string | undefined;
  /** The caller's access reaches only some namespaces. */
  limited: boolean;
  mayUseAdvanced: boolean;
  backupLocations: NamedList | undefined;
  snapshotLocations: NamedList | undefined;
  /** A backup is named here; a schedule is named on its own step. */
  withName: boolean;
  /** "backup" or "schedule template": what the advanced settings are merged onto. */
  advancedTarget: string;
}

/**
 * The fields of a backup spec, in the three steps of the backup wizard. The schedule
 * wizard shows the same fields for its template, so the two cannot drift apart.
 */
export function TemplateFields(props: TemplateFieldsProps): ReactElement {
  const { step, form, setForm, shown, limited, mayUseAdvanced } = props;
  const set =
    <K extends keyof BackupForm>(key: K) =>
    (value: BackupForm[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    };
  const { backupLocations, snapshotLocations } = props;
  return (
    <>
      {step === 0 && (
        <>
          {props.withName && (
            <Text
              label="Name"
              hint="Optional. Leave empty and the agent names it backup- followed by the time."
              error={shown('name')}
              value={form.name}
              onChange={set('name')}
            />
          )}
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
            <summary className="cursor-pointer text-sm font-medium">More resource filters</summary>
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
            options={locationOptions(backupLocations, 'Velero’s default')}
          />
          <Text
            label="Volume snapshot locations"
            hint={
              snapshotLocations !== undefined && snapshotLocations.items.length > 0
                ? `Comma-separated. Available: ${snapshotLocations.items.map((l) => l.name).join(', ')}.`
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
                ? `Merged onto the ${props.advancedTarget} and checked against Velero’s. For example hooks.`
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
    </>
  );
}
