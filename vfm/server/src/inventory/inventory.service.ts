import { randomUUID } from 'node:crypto';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { newId } from '../common/uuid';
import { EventsService } from '../events/events.service';
import type { AgentMessage } from '../gateway/pb/vfm/agent/v1/gateway';
import {
  ResourceEventType,
  type InventorySnapshot,
  type ResourceEvents,
} from '../gateway/pb/vfm/agent/v1/inventory';
import { ServerMessage } from '../gateway/pb/vfm/agent/v1/gateway';
import { PrismaService } from '../prisma/prisma.service';
import { StreamsService } from '../streams/streams.service';
import { validateItem, validateTombstone, type ValidResource } from './validate';

/** PLAN.md §13: 50 000 Velero objects across the whole installation. One cluster gets no more than this. */
export const MAX_SNAPSHOT_ITEMS = 50_000;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_EVENTS_PER_BATCH = 1_000;
const RESYNC_COOLDOWN_MS = 5_000;
const CREATE_CHUNK = 2_000;
const IDS_CHUNK = 5_000;

interface Assembly {
  snapshotId: string;
  nextSequence: number;
  rows: Map<string, ValidResource>;
  bytes: number;
  rejected: number;
}

interface ClusterState {
  orgId: string;
  assembly: Assembly | undefined;
  /** The snapshot currently applied; deltas are accepted only against it. */
  completedId: string | undefined;
  lastBatch: number;
  lastResyncAt: number;
}

const keyOf = (r: { kind: string; namespace: string; name: string }): string =>
  `${r.kind}/${r.namespace}/${r.name}`;

const dataOf = (
  r: ValidResource,
  snapshotId: string,
): Omit<Prisma.VeleroResourceUncheckedCreateInput, 'id' | 'orgId' | 'clusterId'> => ({
  kind: r.kind,
  namespace: r.namespace,
  name: r.name,
  uid: r.uid,
  resourceVersion: r.resourceVersion,
  creationTimestamp: r.creationTimestamp,
  phase: r.phase,
  startedAt: r.startedAt,
  completedAt: r.completedAt,
  expiresAt: r.expiresAt,
  spec: r.spec as Prisma.InputJsonObject,
  status: r.status as Prisma.InputJsonObject,
  labels: r.labels,
  createdByVfm: r.createdByVfm,
  snapshotId,
  deletedAt: null,
});

/**
 * Keeps `velero_resources` equal to what each cluster's agent reports (PLAN.md
 * §5.3, §16 day 17).
 *
 * ## The contract with the agent
 * A **snapshot** is assembled in memory chunk by chunk and applied in **one
 * transaction** when its last chunk arrives, so a reader sees the old inventory or
 * the new one and never half of either; a snapshot that is interrupted is simply
 * discarded. A **delta** is accepted only against the snapshot that is currently
 * applied and only in sequence. Anything else (an unknown snapshot, a gap, a chunk
 * out of order) is not patched around: it is refused and the agent is asked for a
 * fresh snapshot. That one rule is what makes a lost message harmless.
 *
 * ## Trust
 * The agent is semi-trusted. Each item is validated (`validate.ts`) and an item that
 * fails is skipped, never stored as sent. State is per cluster and keyed by the
 * authenticated stream, so one agent cannot write another cluster's inventory.
 */
@Injectable()
export class InventoryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(InventoryService.name);
  private readonly states = new Map<string, ClusterState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly streams: StreamsService,
    private readonly events: EventsService,
  ) {}

  onApplicationBootstrap(): void {
    this.streams.onConnected((clusterId, orgId) => {
      // A new stream starts clean: whatever the old one had half-sent is void.
      this.states.set(clusterId, {
        orgId,
        assembly: undefined,
        completedId: undefined,
        lastBatch: 0,
        lastResyncAt: 0,
      });
    });
    this.streams.onDisconnected((clusterId) => {
      this.states.delete(clusterId);
    });
    this.streams.onAgentMessage((clusterId, message) => this.onAgentMessage(clusterId, message));
  }

  private async onAgentMessage(clusterId: string, message: AgentMessage): Promise<void> {
    const state = this.states.get(clusterId);
    if (state === undefined) {
      return;
    }
    if (message.snapshot !== undefined) {
      await this.onSnapshot(clusterId, state, message.snapshot);
    } else if (message.events !== undefined) {
      await this.onEvents(clusterId, state, message.events);
    }
  }

  // ---- snapshots ------------------------------------------------------------

  private async onSnapshot(
    clusterId: string,
    state: ClusterState,
    chunk: InventorySnapshot,
  ): Promise<void> {
    if (chunk.sequence === 0) {
      // A new snapshot supersedes any that was still arriving.
      state.assembly = {
        snapshotId: chunk.snapshotId,
        nextSequence: 0,
        rows: new Map(),
        bytes: 0,
        rejected: 0,
      };
    }

    const assembly = state.assembly;
    if (assembly?.snapshotId !== chunk.snapshotId || assembly.nextSequence !== chunk.sequence) {
      state.assembly = undefined;
      await this.requestResync(clusterId, state, 'snapshot chunk out of sequence');
      return;
    }

    for (const item of chunk.items) {
      assembly.bytes += item.objectJson.length;
      const result = validateItem(item);
      if (!result.ok) {
        assembly.rejected += 1;
        if (assembly.rejected <= 3) {
          this.logger.warn(`cluster ${clusterId}: refused an inventory item (${result.reason})`);
        }
        continue;
      }
      assembly.rows.set(keyOf(result.value), result.value);
    }
    assembly.nextSequence += 1;

    if (assembly.rows.size > MAX_SNAPSHOT_ITEMS || assembly.bytes > MAX_SNAPSHOT_BYTES) {
      // Asking again would only repeat it: drop it and say so.
      this.logger.warn(
        `cluster ${clusterId}: the inventory snapshot exceeds the size limits and was discarded`,
      );
      state.assembly = undefined;
      return;
    }

    if (chunk.last) {
      state.assembly = undefined;
      await this.applySnapshot(clusterId, state, assembly);
    }
  }

  private async applySnapshot(
    clusterId: string,
    state: ClusterState,
    assembly: Assembly,
  ): Promise<void> {
    const now = new Date();
    const changedKinds = new Set<string>();

    await this.prisma.inOrg(state.orgId, () =>
      this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.veleroResource.findMany({
            where: { clusterId },
            select: {
              id: true,
              kind: true,
              namespace: true,
              name: true,
              uid: true,
              resourceVersion: true,
              deletedAt: true,
            },
          });
          const known = new Map(existing.map((row) => [keyOf(row), row]));

          const toCreate: Prisma.VeleroResourceCreateManyInput[] = [];
          for (const row of assembly.rows.values()) {
            const current = known.get(keyOf(row));
            if (current === undefined) {
              toCreate.push({
                id: newId(),
                orgId: state.orgId,
                clusterId,
                ...dataOf(row, assembly.snapshotId),
              });
              changedKinds.add(row.kind);
            } else if (
              current.resourceVersion !== row.resourceVersion ||
              current.uid !== row.uid ||
              current.deletedAt !== null
            ) {
              // Only what actually changed is written: at a routine resync almost
              // nothing has, and 50 000 identical updates would be the cost.
              await tx.veleroResource.update({
                where: { id: current.id },
                data: dataOf(row, assembly.snapshotId),
              });
              changedKinds.add(row.kind);
            }
          }

          for (let i = 0; i < toCreate.length; i += CREATE_CHUNK) {
            await tx.veleroResource.createMany({ data: toCreate.slice(i, i + CREATE_CHUNK) });
          }

          // Present before, absent now: gone from the cluster.
          const gone = existing.filter(
            (row) => row.deletedAt === null && !assembly.rows.has(keyOf(row)),
          );
          for (let i = 0; i < gone.length; i += IDS_CHUNK) {
            await tx.veleroResource.updateMany({
              where: { id: { in: gone.slice(i, i + IDS_CHUNK).map((row) => row.id) } },
              data: { deletedAt: now, snapshotId: assembly.snapshotId },
            });
          }
          for (const row of gone) {
            changedKinds.add(row.kind);
          }

          await tx.cluster.update({
            where: { id: clusterId },
            data: { inventorySnapshotId: assembly.snapshotId, inventorySyncedAt: now },
          });
        },
        { timeout: 60_000, maxWait: 10_000 },
      ),
    );

    state.completedId = assembly.snapshotId;
    state.lastBatch = 0;
    this.logger.log(
      `cluster ${clusterId}: inventory snapshot applied (${assembly.rows.size.toString()} objects, ${assembly.rejected.toString()} refused)`,
    );
    if (changedKinds.size > 0) {
      await this.events.publish({
        type: 'inventory',
        orgId: state.orgId,
        clusterId,
        kinds: [...changedKinds],
      });
    }
  }

  // ---- deltas ---------------------------------------------------------------

  private async onEvents(
    clusterId: string,
    state: ClusterState,
    batch: ResourceEvents,
  ): Promise<void> {
    if (state.completedId === undefined || batch.snapshotId !== state.completedId) {
      await this.requestResync(clusterId, state, 'delta for a snapshot that is not applied');
      return;
    }
    if (batch.batchSequence <= state.lastBatch) {
      return; // a replay
    }
    if (batch.batchSequence !== state.lastBatch + 1 || batch.events.length > MAX_EVENTS_PER_BATCH) {
      // A gap means something was lost; patching around it would hide that.
      state.completedId = undefined;
      await this.requestResync(clusterId, state, 'delta batch out of sequence');
      return;
    }

    const now = new Date();
    const changedKinds = new Set<string>();
    const operations: Prisma.PrismaPromise<unknown>[] = [];
    let refused = 0;

    await this.prisma.inOrg(state.orgId, async () => {
      for (const event of batch.events) {
        if (event.item === undefined) {
          refused += 1;
          continue;
        }
        if (event.type === ResourceEventType.RESOURCE_EVENT_TYPE_DELETE) {
          const tomb = validateTombstone(event.item);
          if (!tomb.ok) {
            refused += 1;
            continue;
          }
          operations.push(
            this.prisma.veleroResource.updateMany({
              // The uid must match: a stale delete for an earlier incarnation must
              // not remove an object that has since been recreated under the name.
              where: {
                clusterId,
                kind: tomb.value.kind,
                namespace: tomb.value.namespace,
                name: tomb.value.name,
                uid: tomb.value.uid,
                deletedAt: null,
              },
              data: { deletedAt: now, snapshotId: batch.snapshotId },
            }),
          );
          changedKinds.add(tomb.value.kind);
        } else if (event.type === ResourceEventType.RESOURCE_EVENT_TYPE_UPSERT) {
          const valid = validateItem(event.item);
          if (!valid.ok) {
            refused += 1;
            continue;
          }
          const data = dataOf(valid.value, batch.snapshotId);
          operations.push(
            this.prisma.veleroResource.upsert({
              where: {
                clusterId_kind_namespace_name: {
                  clusterId,
                  kind: valid.value.kind,
                  namespace: valid.value.namespace,
                  name: valid.value.name,
                },
              },
              create: { id: newId(), orgId: state.orgId, clusterId, ...data },
              update: data,
            }),
          );
          changedKinds.add(valid.value.kind);
        } else {
          refused += 1;
        }
      }
      if (operations.length > 0) {
        await this.prisma.$transaction(operations);
      }
    });

    state.lastBatch = batch.batchSequence;
    if (refused > 0) {
      this.logger.warn(
        `cluster ${clusterId}: refused ${refused.toString()} item(s) in a delta batch`,
      );
    }
    if (changedKinds.size > 0) {
      await this.events.publish({
        type: 'inventory',
        orgId: state.orgId,
        clusterId,
        kinds: [...changedKinds],
      });
    }
  }

  // ---- asking again ---------------------------------------------------------

  private async requestResync(
    clusterId: string,
    state: ClusterState,
    reason: string,
  ): Promise<void> {
    const now = Date.now();
    if (now - state.lastResyncAt < RESYNC_COOLDOWN_MS) {
      return;
    }
    state.lastResyncAt = now;
    this.logger.warn(`cluster ${clusterId}: asking the agent for a new snapshot (${reason})`);
    await this.streams
      .send(clusterId, ServerMessage.fromPartial({ messageId: randomUUID(), resync: { reason } }))
      .catch(() => false);
  }
}
