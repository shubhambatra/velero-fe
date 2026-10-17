import { podSummary } from '../inventory/projections';

type PodRow = Parameters<typeof podSummary>[0];

export interface LogTarget {
  pod: string;
  container: string;
  node: string | null;
}

export interface VeleroLogTargets {
  server: LogTarget[];
  nodeAgent: LogTarget[];
}

const isVeleroServer = (owner: { kind: string; name: string }): boolean =>
  (owner.kind === 'ReplicaSet' || owner.kind === 'Deployment') &&
  (owner.name === 'velero' || owner.name.startsWith('velero-')) &&
  !owner.name.startsWith('velero-node-agent');

const isNodeAgent = (owner: { kind: string; name: string }): boolean =>
  owner.kind === 'DaemonSet' &&
  (owner.name === 'node-agent' || owner.name === 'restic' || owner.name.endsWith('-node-agent'));

/**
 * Picks Velero's own pods out of the pods of its namespace, for the log shortcuts
 * (PLAN.md §7.3).
 *
 * By the controller that owns the pod, because the inventory keeps no pod labels (a pod's
 * labels and annotations are not on the allowlist). `velero install` and the Helm chart
 * both name the Deployment `velero` and the DaemonSet `node-agent` (`restic` before 1.10).
 * An installation that names them otherwise gets no shortcut and the pod picker instead,
 * which is the cost of not reading more of a pod than it has to.
 *
 * Only pods that can be read now (Running) are offered, the container named after the
 * component first.
 */
export function veleroLogTargets(rows: readonly PodRow[]): VeleroLogTargets {
  const out: VeleroLogTargets = { server: [], nodeAgent: [] };
  for (const row of rows) {
    const pod = podSummary(row);
    if (pod.owner === null || pod.phase !== 'Running') {
      continue;
    }
    const containers = pod.containers.flatMap((c) => (c.init || c.name === null ? [] : [c.name]));
    const first = containers[0];
    if (first === undefined) {
      continue;
    }
    const preferred = (name: string): string => (containers.includes(name) ? name : first);
    const owner = { kind: pod.owner.kind ?? '', name: pod.owner.name ?? '' };
    if (isNodeAgent(owner)) {
      out.nodeAgent.push({ pod: pod.name, container: preferred('node-agent'), node: pod.node });
    } else if (isVeleroServer(owner)) {
      out.server.push({ pod: pod.name, container: preferred('velero'), node: pod.node });
    }
  }
  const byPod = (a: LogTarget, b: LogTarget): number => a.pod.localeCompare(b.pod);
  out.server.sort(byPod);
  out.nodeAgent.sort(byPod);
  return out;
}
