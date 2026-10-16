import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Cluster } from '@prisma/client';

import { CaService } from '../ca/ca.service';
import { newId } from '../common/uuid';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';
import { StreamsService } from '../streams/streams.service';
import { EnrollmentService } from './enrollment.service';
import { buildInstallCommand } from './install-command';

export interface ClusterView {
  id: string;
  name: string;
  status: Cluster['status'];
  k8sVersion: string | null;
  veleroVersion: string | null;
  veleroPlugins: unknown;
  agentVersion: string | null;
  chartVersion: string | null;
  imageTag: string | null;
  /** True when the agent reports an older chart than this control plane ships. */
  agentUpdateAvailable: boolean;
  protocolVersion: number | null;
  agentPolicy: unknown;
  capabilities: unknown;
  lastSeenAt: Date | null;
  labels: unknown;
  grafanaUrlTemplate: string | null;
  createdAt: Date;
}

export interface EnrollmentGrant {
  /** Shown once. Only its hash is stored. */
  bootstrapToken: string;
  expiresAt: Date;
  /** The copy-paste shell snippet for the operator (PLAN.md §5.1 step 2). */
  installCommand: string;
}

const view = (c: Cluster, expectedChart: string): ClusterView => ({
  id: c.id,
  name: c.name,
  status: c.status,
  k8sVersion: c.k8sVersion,
  veleroVersion: c.veleroVersion,
  veleroPlugins: c.veleroPlugins,
  agentVersion: c.agentVersion,
  chartVersion: c.chartVersion,
  imageTag: c.imageTag,
  agentUpdateAvailable: isOlder(c.chartVersion, expectedChart),
  protocolVersion: c.protocolVersion,
  agentPolicy: c.agentPolicy,
  capabilities: c.capabilities,
  lastSeenAt: c.lastSeenAt,
  labels: c.labels,
  grafanaUrlTemplate: c.grafanaUrlTemplate,
  createdAt: c.createdAt,
});

/** Whether `have` is an older release than `expected`. Pre-release suffixes are ignored; an unknown version is not "older". */
export function isOlder(have: string | null, expected: string): boolean {
  if (have === null) {
    return false;
  }
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = parse(have);
  const b = parse(expected);
  if (a === null || b === null) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) < (b[i] ?? 0);
    }
  }
  return false;
}

/** Clusters of one organization (PLAN.md §10 `/orgs/{orgId}/clusters`). */
@Injectable()
export class ClustersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollment: EnrollmentService,
    private readonly ca: CaService,
    private readonly rbac: RbacService,
    private readonly streams: StreamsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async create(
    orgId: string,
    input: { name: string; labels?: Record<string, string> | undefined },
  ): Promise<{ cluster: ClusterView } & EnrollmentGrant> {
    let cluster: Cluster;
    try {
      cluster = await this.prisma.inOrg(orgId, () =>
        this.prisma.cluster.create({
          data: { id: newId(), orgId, name: input.name, labels: input.labels ?? {} },
        }),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('a cluster with that name already exists');
      }
      throw error;
    }
    return {
      cluster: view(cluster, this.env.AGENT_CHART_VERSION),
      ...(await this.grant(orgId, cluster)),
    };
  }

  /**
   * The clusters the caller may see: Owners and Admins all of them, everyone
   * else those where a role binding gives `cluster:read`. A cluster the caller
   * cannot read does not appear, rather than appearing greyed out.
   */
  async list(
    orgId: string,
    userId: string,
    token?: { permissions: string[] | null; clusterIds: string[] | null },
  ): Promise<ClusterView[]> {
    const clusters = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findMany({ orderBy: { name: 'asc' } }),
    );

    const visible: Cluster[] = [];
    for (const cluster of clusters) {
      const { may } = await this.rbac.mayAttempt(orgId, userId, cluster.id, 'cluster:read', token);
      if (may) {
        visible.push(cluster);
      }
    }
    return visible.map((c) => view(c, this.env.AGENT_CHART_VERSION));
  }

  async get(orgId: string, clusterId: string): Promise<ClusterView> {
    return view(await this.find(orgId, clusterId), this.env.AGENT_CHART_VERSION);
  }

  async update(
    orgId: string,
    clusterId: string,
    input: {
      name?: string | undefined;
      labels?: Record<string, string> | undefined;
      grafanaUrlTemplate?: string | null | undefined;
    },
  ): Promise<ClusterView> {
    await this.find(orgId, clusterId);
    try {
      const updated = await this.prisma.inOrg(orgId, () =>
        this.prisma.cluster.update({
          where: { id: clusterId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.labels === undefined ? {} : { labels: input.labels }),
            ...(input.grafanaUrlTemplate === undefined
              ? {}
              : { grafanaUrlTemplate: input.grafanaUrlTemplate }),
          },
        }),
      );
      return view(updated, this.env.AGENT_CHART_VERSION);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('a cluster with that name already exists');
      }
      throw error;
    }
  }

  /**
   * Deleting removes the certificate rows with the cluster; the gateway denies
   * any serial it cannot find, so a deleted cluster's agent is locked out
   * immediately (PLAN.md §5.1 step 6).
   */
  async remove(orgId: string, clusterId: string): Promise<void> {
    await this.find(orgId, clusterId);
    await this.prisma.inOrg(orgId, () => this.prisma.cluster.delete({ where: { id: clusterId } }));
    await this.streams.closeCluster(clusterId, 'the cluster was deleted');
  }

  async disable(orgId: string, clusterId: string): Promise<ClusterView> {
    await this.find(orgId, clusterId);
    const [, updated] = await this.prisma.inOrg(orgId, () =>
      this.prisma.$transaction([
        this.prisma.agentCertificate.updateMany({
          where: { clusterId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        this.prisma.cluster.update({ where: { id: clusterId }, data: { status: 'DISABLED' } }),
        this.prisma.clusterBootstrapToken.deleteMany({ where: { clusterId, usedAt: null } }),
      ]),
    );
    await this.streams.closeCluster(clusterId, 'the cluster was disabled');
    return view(updated, this.env.AGENT_CHART_VERSION);
  }

  /** Back to `PENDING`: a disabled cluster needs a fresh token to enrol again. */
  async enable(
    orgId: string,
    clusterId: string,
  ): Promise<{ cluster: ClusterView } & EnrollmentGrant> {
    const cluster = await this.find(orgId, clusterId);
    if (cluster.status !== 'DISABLED') {
      throw new ConflictException('the cluster is not disabled');
    }
    const updated = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.update({ where: { id: clusterId }, data: { status: 'PENDING' } }),
    );
    return {
      cluster: view(updated, this.env.AGENT_CHART_VERSION),
      ...(await this.grant(orgId, updated)),
    };
  }

  /**
   * A new bootstrap token without touching existing certificates: for a cluster
   * whose token expired before the agent was installed. `resetFingerprint` lets
   * the next agent come from a different cluster than the last.
   */
  async reissueToken(
    orgId: string,
    clusterId: string,
    options: { resetFingerprint: boolean },
  ): Promise<EnrollmentGrant> {
    const cluster = await this.find(orgId, clusterId);
    if (cluster.status === 'DISABLED') {
      throw new ConflictException('enable the cluster before issuing a new token');
    }
    if (options.resetFingerprint) {
      await this.prisma.inOrg(orgId, () =>
        this.prisma.cluster.update({ where: { id: clusterId }, data: { fingerprint: null } }),
      );
    }
    return this.grant(orgId, cluster);
  }

  /**
   * Revokes every certificate the agent holds and issues a token, so the agent
   * must enrol again. The right response to a suspected key leak.
   */
  async rotateCertificate(
    orgId: string,
    clusterId: string,
  ): Promise<EnrollmentGrant & { revoked: number }> {
    const cluster = await this.find(orgId, clusterId);
    if (cluster.status === 'DISABLED') {
      throw new ConflictException('enable the cluster before rotating its certificate');
    }
    const revoked = await this.enrollment.revokeCertificates(orgId, clusterId);
    await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.update({ where: { id: clusterId }, data: { status: 'PENDING' } }),
    );
    await this.streams.closeCluster(clusterId, 'the agent certificates were rotated');
    return { revoked, ...(await this.grant(orgId, cluster)) };
  }

  private async find(orgId: string, clusterId: string): Promise<Cluster> {
    const cluster = await this.prisma.inOrg(orgId, () =>
      this.prisma.cluster.findUnique({ where: { id: clusterId } }),
    );
    if (cluster === null) {
      throw new NotFoundException('cluster not found');
    }
    return cluster;
  }

  private async grant(orgId: string, cluster: Cluster): Promise<EnrollmentGrant> {
    const { token, expiresAt } = await this.enrollment.issueToken(orgId, cluster.id);
    return {
      bootstrapToken: token,
      expiresAt,
      installCommand: buildInstallCommand({
        chartRef: this.env.AGENT_CHART_REF,
        gatewayAddress: this.env.GATEWAY_PUBLIC_ADDRESS,
        caBundlePem: await this.ca.certificatePem(),
        bootstrapToken: token,
        clusterName: cluster.name,
      }),
    };
  }
}
