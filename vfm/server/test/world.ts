import { createHash } from 'node:crypto';

import type request from 'supertest';

import { CSRF_HEADER } from '../src/auth/csrf.guard';
import { SessionService } from '../src/auth/session.service';
import { CaService } from '../src/ca/ca.service';
import { GatewayService } from '../src/gateway/gateway.service';
import type { AgentGatewayClient } from '../src/gateway/pb/vfm/agent/v1/gateway';
import { ResourceKind, type ResourceItem } from '../src/gateway/pb/vfm/agent/v1/inventory';
import {
  enrollWith,
  hello,
  keypair,
  makeClient,
  openStream,
  type AgentCert,
  type OpenStream,
} from './agent-harness';
import type { TestApp } from './app-harness';

export const PASSWORD = 'canopy-vellum-ratchet-82';
const FINGERPRINT = 'f3a1c2d4-kube-system-uid-0001';

export type Call = (
  method: 'get' | 'post' | 'delete' | 'patch',
  path: string,
  body?: object,
) => request.Test;

export interface Agent {
  clusterId: string;
  name: string;
  cert: AgentCert;
}

/**
 * An organization, its administrator and enrolled agents, over a real gateway.
 * Shared by the suites that need a populated installation (inventory, SSE).
 */
export class World {
  readonly clients: AgentGatewayClient[] = [];
  port = 0;
  caPem = '';

  constructor(readonly harness: TestApp) {}

  async init(): Promise<void> {
    this.port = this.harness.app.get(GatewayService).boundPort;
    this.caPem = await this.harness.app.get(CaService).certificatePem();
  }

  close(): void {
    for (const client of this.clients) {
      client.close();
    }
  }

  async actAs(userId: string, harness: TestApp = this.harness): Promise<Call> {
    const created = await harness.app
      .get(SessionService)
      .create({ userId, ip: '127.0.0.1', userAgent: 'vitest' });
    const cookie = `${SessionService.COOKIE}=${created.id}; ${SessionService.CSRF_COOKIE}=${created.csrfToken}`;
    const call: Call = (method, path, body) => {
      const req = harness
        .api()
        [method](`/api/v1${path}`)
        .set('Cookie', cookie)
        .set(CSRF_HEADER, created.csrfToken);
      return body === undefined ? req : req.send(body);
    };
    return Object.assign(call, { cookie, sessionId: created.id });
  }

  async admin(): Promise<{ call: Call; userId: string; orgId: string }> {
    const token = 'setup-' + Math.random().toString(36).slice(2);
    await this.harness.redis.connection.set(
      'vfm:setup:token',
      createHash('sha256').update(token, 'utf8').digest('hex'),
      'EX',
      3_600,
    );
    const user = await this.harness
      .api()
      .post('/api/v1/auth/setup')
      .send({ token, email: 'root@vfm.local', password: PASSWORD })
      .expect(201);
    const userId = (user.body as { user: { id: string } }).user.id;
    const call = await this.actAs(userId);
    const org = await call('post', '/orgs', { name: 'Acme', slug: 'acme' }).expect(201);
    const orgId = (org.body as { id: string }).id;
    await call('post', '/me/active-org', { orgId }).expect(204);
    return { call, userId, orgId };
  }

  async member(owner: Call, orgId: string, email: string): Promise<{ call: Call; userId: string }> {
    await owner('post', `/orgs/${orgId}/invites`, { email, orgRole: 'MEMBER' }).expect(201);
    const reg = await this.harness
      .api()
      .post('/api/v1/invites/register')
      .send({ token: this.harness.mail.tokenFor(email), password: PASSWORD, name: email })
      .expect(201);
    const userId = (reg.body as { user: { id: string } }).user.id;
    const call = await this.actAs(userId);
    await call('post', '/me/active-org', { orgId }).expect(204);
    return { call, userId };
  }

  async agent(call: Call, orgId: string, name: string): Promise<Agent> {
    const created = (await call('post', `/orgs/${orgId}/clusters`, { name }).expect(201)).body as {
      bootstrapToken: string;
      cluster: { id: string };
    };
    const keys = await keypair();
    const response = await enrollWith(
      makeClient(this.port, this.caPem, undefined, this.clients),
      created.bootstrapToken,
      keys.csrPem,
      `${FINGERPRINT}-${name}`,
    );
    return {
      clusterId: created.cluster.id,
      name,
      cert: { chain: Buffer.from(response.certificatePem).toString(), key: keys.privateKeyPem },
    };
  }

  async connect(agent: Agent, port: number = this.port): Promise<OpenStream> {
    const stream = openStream(makeClient(port, this.caPem, agent.cert, this.clients));
    stream.send(hello({ clusterFingerprint: `${FINGERPRINT}-${agent.name}` }));
    const ack = await stream.next();
    if (ack.helloAck === undefined) {
      throw new Error('the gateway did not acknowledge Hello');
    }
    return stream;
  }
}

const enc = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));

const OBJECT_KIND: Partial<Record<ResourceKind, string>> = {
  [ResourceKind.RESOURCE_KIND_BACKUP]: 'Backup',
  [ResourceKind.RESOURCE_KIND_RESTORE]: 'Restore',
  [ResourceKind.RESOURCE_KIND_SCHEDULE]: 'Schedule',
  [ResourceKind.RESOURCE_KIND_BACKUP_STORAGE_LOCATION]: 'BackupStorageLocation',
  [ResourceKind.RESOURCE_KIND_POD_VOLUME_BACKUP]: 'PodVolumeBackup',
  [ResourceKind.RESOURCE_KIND_VOLUME_SNAPSHOT_LOCATION]: 'VolumeSnapshotLocation',
  [ResourceKind.RESOURCE_KIND_BACKUP_REPOSITORY]: 'BackupRepository',
  [ResourceKind.RESOURCE_KIND_DATA_UPLOAD]: 'DataUpload',
};

/** A well-formed inventory item, the way a healthy agent reports it. */
export function resource(
  name: string,
  options: {
    kind?: ResourceKind;
    phase?: string;
    uid?: string;
    rv?: string;
    status?: Record<string, unknown>;
    spec?: Record<string, unknown>;
    labels?: Record<string, string>;
    managed?: boolean;
    started?: string;
  } = {},
): ResourceItem {
  const kind = options.kind ?? ResourceKind.RESOURCE_KIND_BACKUP;
  const uid = options.uid ?? `uid-${name}`;
  return {
    kind,
    namespace: 'velero',
    name,
    uid,
    resourceVersion: options.rv ?? '1',
    creationTimestamp: undefined,
    objectJson: enc({
      apiVersion: 'velero.io/v1',
      kind: OBJECT_KIND[kind] ?? 'Backup',
      metadata: {
        name,
        namespace: 'velero',
        uid,
        creationTimestamp: '2026-10-16T01:00:00Z',
        ...(options.labels === undefined ? {} : { labels: options.labels }),
        ...(options.managed === true ? { annotations: { 'vfm.io/managed': 'true' } } : {}),
      },
      spec: options.spec ?? { storageLocation: 'default' },
      status: {
        phase: options.phase ?? 'Completed',
        startTimestamp: options.started ?? '2026-10-16T01:00:05Z',
        ...options.status,
      },
    }),
  };
}

export const tombstone = (
  name: string,
  uid = `uid-${name}`,
  kind = ResourceKind.RESOURCE_KIND_BACKUP,
): ResourceItem => ({
  kind,
  namespace: 'velero',
  name,
  uid,
  resourceVersion: '',
  creationTimestamp: undefined,
  objectJson: new Uint8Array(),
});
