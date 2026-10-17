import { describe, expect, it } from 'vitest';

import { veleroLogTargets } from './velero-pods';

const pod = (
  name: string,
  owner: { kind: string; name: string } | null,
  containers: string[],
  phase = 'Running',
  node = 'node-1',
) =>
  ({
    name,
    namespace: 'velero',
    phase,
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    createdByVfm: false,
    labels: {},
    creationTimestamp: null,
    spec: { nodeName: node, ...(owner === null ? {} : { owner }) },
    status: {
      containerStatuses: containers.map((c) => ({ name: c, state: 'running' })),
    },
  }) as Parameters<typeof veleroLogTargets>[0][number];

describe('finding Velero’s own pods', () => {
  it('finds the server by its Deployment and the node agents by their DaemonSet', () => {
    const out = veleroLogTargets([
      pod('velero-6d8f7-abcde', { kind: 'ReplicaSet', name: 'velero-6d8f7' }, ['velero']),
      pod(
        'node-agent-b',
        { kind: 'DaemonSet', name: 'node-agent' },
        ['node-agent'],
        'Running',
        'n2',
      ),
      pod(
        'node-agent-a',
        { kind: 'DaemonSet', name: 'node-agent' },
        ['node-agent'],
        'Running',
        'n1',
      ),
    ]);
    expect(out.server).toEqual([
      { pod: 'velero-6d8f7-abcde', container: 'velero', node: 'node-1' },
    ]);
    expect(out.nodeAgent.map((t) => t.pod)).toEqual(['node-agent-a', 'node-agent-b']);
    expect(out.nodeAgent[0]).toMatchObject({ container: 'node-agent', node: 'n1' });
  });

  it('knows the older DaemonSet name', () => {
    const out = veleroLogTargets([
      pod('restic-x', { kind: 'DaemonSet', name: 'restic' }, ['restic']),
    ]);
    expect(out.nodeAgent).toHaveLength(1);
  });

  it('does not take other workloads in the namespace, or a node agent for the server', () => {
    const out = veleroLogTargets([
      pod('grafana-1', { kind: 'ReplicaSet', name: 'grafana-5f' }, ['grafana']),
      pod('velero-node-agent-x', { kind: 'DaemonSet', name: 'velero-node-agent' }, ['node-agent']),
      pod('orphan', null, ['velero']),
    ]);
    expect(out.server).toEqual([]);
    expect(out.nodeAgent.map((t) => t.pod)).toEqual(['velero-node-agent-x']);
  });

  it('offers only pods that can be read now, and never an init container', () => {
    const out = veleroLogTargets([
      pod('velero-a', { kind: 'ReplicaSet', name: 'velero-1' }, ['velero'], 'Pending'),
      pod('velero-b', { kind: 'ReplicaSet', name: 'velero-1' }, ['velero'], 'Failed'),
    ]);
    expect(out.server).toEqual([]);

    const withInit = pod('velero-c', { kind: 'ReplicaSet', name: 'velero-1' }, [
      'sidecar',
      'velero',
    ]);
    (withInit.status as { containerStatuses: unknown[] }).containerStatuses.unshift({
      name: 'setup',
      init: true,
      state: 'terminated',
    });
    expect(veleroLogTargets([withInit]).server[0]?.container).toBe('velero');
  });

  it('falls back to the first container when none is named after the component', () => {
    const out = veleroLogTargets([
      pod('velero-d', { kind: 'ReplicaSet', name: 'velero-1' }, ['main']),
    ]);
    expect(out.server[0]?.container).toBe('main');
  });
});
