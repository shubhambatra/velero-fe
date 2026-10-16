import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceKind } from '../src/gateway/pb/vfm/agent/v1/inventory';
import type { OpenStream } from './agent-harness';
import { createTestApp, type TestApp } from './app-harness';
import { resource, World, type Agent, type Call } from './world';

/**
 * M5 day 28: the live view of a cluster (PLAN.md §7.1): nodes, namespaces, pod
 * summaries, PVCs and events, read back through the API; who sees which namespace; what
 * the control plane refuses from an agent; and the pod scope sent to an agent.
 */
const K = ResourceKind;
const now = () => new Date().toISOString();

describe('the live view (e2e)', () => {
  let harness: TestApp;
  let world: World;

  beforeAll(async () => {
    harness = await createTestApp({ gateway: true });
    world = new World(harness);
    await world.init();
  }, 60_000);

  afterAll(async () => {
    world.close();
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const value = await read();
      if (ok(value)) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out');
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const node = (name: string, extra: object = {}) =>
    resource(name, {
      kind: K.RESOURCE_KIND_NODE,
      namespace: '',
      phase: 'Ready',
      labels: { 'node-role.kubernetes.io/control-plane': '' },
      spec: {
        unschedulable: false,
        taints: [{ key: 'dedicated', value: 'db', effect: 'NoSchedule' }],
      },
      status: {
        allocatable: { cpu: '4', memory: '16Gi', pods: '110' },
        nodeInfo: { kubeletVersion: 'v1.31.0' },
        conditions: [
          { type: 'MemoryPressure', status: 'True' },
          { type: 'Ready', status: 'True' },
        ],
        ...extra,
      },
    });
  const ns = (name: string) =>
    resource(name, { kind: K.RESOURCE_KIND_NAMESPACE, namespace: '', phase: 'Active', spec: {} });
  const pod = (namespace: string, name: string) =>
    resource(name, {
      kind: K.RESOURCE_KIND_POD,
      namespace,
      phase: 'Running',
      started: now(),
      spec: { nodeName: 'n1', owner: { kind: 'ReplicaSet', name: 'web-abc' } },
      status: {
        readyCount: 1,
        containerCount: 2,
        restartCount: 3,
        containerStatuses: [
          {
            name: 'app',
            image: 'nginx:1',
            ready: true,
            state: 'running',
            restartCount: 2,
            reason: '',
            lastTerminationReason: 'OOMKilled',
          },
          {
            name: 'side',
            image: 'envoy:1',
            ready: false,
            state: 'waiting',
            restartCount: 1,
            reason: 'CrashLoopBackOff',
            lastTerminationReason: '',
          },
        ],
      },
    });
  const pvc = (namespace: string, name: string) =>
    resource(name, {
      kind: K.RESOURCE_KIND_PERSISTENT_VOLUME_CLAIM,
      namespace,
      phase: 'Bound',
      spec: { storageClassName: 'fast', volumeName: 'pv-1' },
      status: { capacity: { storage: '10Gi' } },
    });
  const event = (namespace: string, name: string, started = now()) =>
    resource(name, {
      kind: K.RESOURCE_KIND_EVENT,
      namespace,
      phase: 'Warning',
      started,
      spec: {},
      status: {
        reason: 'BackOff',
        message: 'Back-off restarting failed container',
        count: 4,
        involvedObject: { kind: 'Pod', name: 'web-1', namespace },
      },
    });

  const items = () => [
    node('n1'),
    ns('shop'),
    ns('billing'),
    pod('shop', 'web-1'),
    pod('billing', 'ledger-1'),
    pvc('shop', 'data'),
    pvc('billing', 'ledger-data'),
    event('shop', 'warn-1'),
    event('billing', 'warn-2'),
    event('shop', 'stale', new Date(Date.now() - 2 * 3_600_000).toISOString()),
  ];

  async function setup(inventory = items()) {
    const { call, orgId, userId } = await world.admin();
    const agent = await world.agent(call, orgId, 'prod-eu');
    const stream = await world.connect(agent);
    stream.send({
      messageId: 's',
      snapshot: { snapshotId: 's1', sequence: 0, last: true, items: inventory },
    });
    await eventually(
      () =>
        harness.prisma.unscoped('t', () =>
          harness.prisma.cluster.findUniqueOrThrow({ where: { id: agent.clusterId } }),
        ),
      (c) => c.inventorySnapshotId === 's1',
    );
    return {
      call,
      orgId,
      userId,
      agent,
      stream,
      base: `/orgs/${orgId}/clusters/${agent.clusterId}/inventory`,
    };
  }

  async function member(call: Call, orgId: string, agent: Agent, role: string, scope: object) {
    const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@acme.test`;
    const user = await world.member(call, orgId, email);
    await call('post', `/clusters/${agent.clusterId}/role-bindings`, {
      subjectType: 'USER',
      subjectId: user.userId,
      role,
      scope,
    }).expect(201);
    return user;
  }

  const names = (body: unknown) =>
    (body as { items: { name: string }[] }).items.map((i) => i.name).sort();

  describe('reading it back', () => {
    it('lists nodes with the fields the view shows', async () => {
      const s = await setup();
      const res = await s.call('get', `${s.base}/nodes`).expect(200);
      expect(res.body.items).toEqual([
        {
          name: 'n1',
          phase: 'Ready',
          roles: ['control-plane'],
          kubeletVersion: 'v1.31.0',
          allocatable: { cpu: '4', memory: '16Gi', pods: '110' },
          pressure: ['MemoryPressure'],
          schedulable: true,
          taints: [{ key: 'dedicated', value: 'db', effect: 'NoSchedule' }],
        },
      ]);
      s.stream.cancel();
    });

    it('lists namespaces, pods, claims and events, and filters them by namespace', async () => {
      const s = await setup();
      expect(names((await s.call('get', `${s.base}/namespaces`).expect(200)).body)).toEqual([
        'billing',
        'shop',
      ]);

      const pods = await s.call('get', `${s.base}/pods`).expect(200);
      expect(names(pods.body)).toEqual(['ledger-1', 'web-1']);
      const web = (await s.call('get', `${s.base}/pods?namespace=shop`).expect(200)).body.items[0];
      expect(web).toMatchObject({
        namespace: 'shop',
        name: 'web-1',
        phase: 'Running',
        ready: '1/2',
        restarts: 3,
        node: 'n1',
        owner: { kind: 'ReplicaSet', name: 'web-abc' },
      });
      expect(web.containers).toEqual([
        expect.objectContaining({
          name: 'app',
          state: 'running',
          lastTerminationReason: 'OOMKilled',
        }),
        expect.objectContaining({
          name: 'side',
          state: 'waiting',
          reason: 'CrashLoopBackOff',
          ready: false,
        }),
      ]);

      const claims = (await s.call('get', `${s.base}/pvcs?namespace=shop`).expect(200)).body.items;
      expect(claims).toEqual([
        {
          namespace: 'shop',
          name: 'data',
          phase: 'Bound',
          capacity: '10Gi',
          storageClass: 'fast',
          volume: 'pv-1',
        },
      ]);
      s.stream.cancel();
    });

    it('lists only the events of the last hour', async () => {
      const s = await setup();
      const res = await s.call('get', `${s.base}/events`).expect(200);
      expect(names(res.body)).toEqual(['warn-1', 'warn-2']);
      expect(res.body.items[0]).toMatchObject({ type: 'Warning', reason: 'BackOff', count: 4 });
      s.stream.cancel();
    });

    it('refuses a filter or a sort the list does not offer', async () => {
      const s = await setup();
      await s.call('get', `${s.base}/nodes?namespace=shop`).expect(400);
      await s.call('get', `${s.base}/pods?sort=bogus`).expect(400);
      s.stream.cancel();
    });
  });

  describe('who sees what', () => {
    it('shows a namespace-limited viewer only their namespaces, but every node', async () => {
      const s = await setup();
      const viewer = await member(s.call, s.orgId, s.agent, 'VIEWER', {
        type: 'NAMESPACES',
        namespaces: ['shop'],
      });
      expect(names((await viewer.call('get', `${s.base}/namespaces`).expect(200)).body)).toEqual([
        'shop',
      ]);
      expect(names((await viewer.call('get', `${s.base}/pods`).expect(200)).body)).toEqual([
        'web-1',
      ]);
      expect(names((await viewer.call('get', `${s.base}/pvcs`).expect(200)).body)).toEqual([
        'data',
      ]);
      expect(names((await viewer.call('get', `${s.base}/events`).expect(200)).body)).toEqual([
        'warn-1',
      ]);
      expect(names((await viewer.call('get', `${s.base}/nodes`).expect(200)).body)).toEqual(['n1']);
      expect(
        (await viewer.call('get', `${s.base}/pods?namespace=billing`).expect(200)).body.items,
      ).toEqual([]);
      s.stream.cancel();
    });

    it('does not count pods in namespaces the caller cannot see', async () => {
      const s = await setup();
      const viewer = await member(s.call, s.orgId, s.agent, 'VIEWER', {
        type: 'NAMESPACES',
        namespaces: ['shop'],
      });
      const summary = await viewer.call('get', s.base).expect(200);
      expect(
        Object.keys(summary.body.kinds as object).filter((k) =>
          ['POD', 'EVENT', 'NAMESPACE', 'NODE'].includes(k),
        ),
      ).toEqual([]);
      s.stream.cancel();
    });

    it('shows nothing to someone with no access to the cluster', async () => {
      const s = await setup();
      const other = await world.member(s.call, s.orgId, 'nobody@acme.test');
      await other.call('get', `${s.base}/pods`).expect(404);
      s.stream.cancel();
    });
  });

  describe('what the control plane accepts from an agent', () => {
    it('refuses a node that claims a namespace, a pod with none, and an object filed as another kind', async () => {
      const s = await setup([]);
      const before = (await s.call('get', `${s.base}/nodes`)).body.items.length;
      s.stream.send({
        messageId: 's2',
        snapshot: {
          snapshotId: 's2',
          sequence: 0,
          last: true,
          items: [
            { ...node('bad-node'), namespace: 'shop' },
            { ...pod('shop', 'bad-pod'), namespace: '' },
            { ...pod('shop', 'wrong-kind'), kind: K.RESOURCE_KIND_PERSISTENT_VOLUME_CLAIM },
            pod('shop', 'good'),
          ],
        },
      });
      await eventually(
        () => s.call('get', `${s.base}/pods`).then((r) => names(r.body)),
        (n) => n.join() === 'good',
      );
      expect(names((await s.call('get', `${s.base}/nodes`)).body)).toEqual([]);
      expect(before).toBe(0);
      s.stream.cancel();
    });
  });

  describe('the pod scope sent to the agent', () => {
    async function nextScope(stream: OpenStream): Promise<string[]> {
      for (let i = 0; i < 6; i += 1) {
        const message = await stream.next(3_000);
        if (message.watchScope !== undefined) {
          return [...message.watchScope.podNamespaces];
        }
      }
      throw new Error('no WatchScope arrived');
    }

    it('sends nothing at first, grows when someone looks at a namespace, and does not repeat itself', async () => {
      const s = await setup();
      // Nothing is wanted yet, and a new agent already assumes that: nothing is sent.
      await s.call('get', `${s.base}/pods?namespace=shop`).expect(200);
      expect(await nextScope(s.stream)).toEqual(['shop']);

      await s.call('get', `${s.base}/pods?namespace=shop`).expect(200);
      await s.call('get', `${s.base}/pods?namespace=billing`).expect(200);
      expect(await nextScope(s.stream)).toEqual(['billing', 'shop']);
      s.stream.cancel();
    });

    it('does not widen for a namespace the caller may not see', async () => {
      const s = await setup();
      const viewer = await member(s.call, s.orgId, s.agent, 'VIEWER', {
        type: 'NAMESPACES',
        namespaces: ['shop'],
      });
      await viewer.call('get', `${s.base}/pods?namespace=billing`).expect(200);
      await viewer.call('get', `${s.base}/pods?namespace=shop`).expect(200);
      expect(await nextScope(s.stream)).toEqual(['shop']);
      s.stream.cancel();
    });
  });
});
