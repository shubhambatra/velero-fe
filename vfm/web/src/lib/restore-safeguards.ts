import type { RestoreForm } from './restore-form';

export interface SafeguardContext {
  /** `velero.io/source-cluster-k8s-gitversion` from the backup, when it carries one. */
  backupK8sVersion?: string | null;
  clusterK8sVersion?: string | null;
  veleroCompatibility?: string;
}

const minorOf = (v: string | null | undefined): string | null =>
  /^v?(\d+)\.(\d+)/
    .exec(v ?? '')
    ?.slice(1, 3)
    .join('.') ?? null;

/** Reads the source Kubernetes version out of a backup's manifest YAML. */
export function backupK8sVersionOf(yaml: string | undefined): string | null {
  return (
    /velero\.io\/source-cluster-k8s-gitversion:\s*['"]?(v?[\w.+-]+)/.exec(yaml ?? '')?.[1] ?? null
  );
}

/**
 * Risks the browser can name without asking the cluster (SOW FR-10). Missing CRDs and storage
 * classes are not checked: the control plane does not hold them (ADR in docs/DECISIONS.md).
 */
export function safeguardWarnings(form: RestoreForm, ctx: SafeguardContext): string[] {
  const out: string[] = [];
  const from = minorOf(ctx.backupK8sVersion);
  const to = minorOf(ctx.clusterK8sVersion);
  if (from !== null && to !== null && from !== to) {
    out.push(
      `The backup was taken on Kubernetes ${ctx.backupK8sVersion ?? ''} and this cluster runs ${ctx.clusterK8sVersion ?? ''}. API versions may differ, so some resources may fail to restore.`,
    );
  }
  if (ctx.veleroCompatibility === 'warn') {
    out.push('This cluster runs a Velero version newer than the tested one.');
  }
  if (form.existingResourcePolicy === 'update') {
    out.push('Resources that already exist will be overwritten with the backup’s version.');
  }
  if (form.clusterScoped === 'yes') {
    out.push(
      'Cluster-scoped resources (CRDs, ClusterRoles, PersistentVolumes) will be restored and can affect other applications.',
    );
  }
  if (form.restorePVs !== 'no') {
    out.push(
      'Persistent volumes are restored from snapshots. Make sure the storage classes and CSI drivers they use exist on this cluster.',
    );
  }
  return out;
}
