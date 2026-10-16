import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { CommandsService, type CommandView } from '../commands/commands.service';
import { NON_TERMINAL } from '../commands/command-state';
import { coveredBy } from '../inventory/projections';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService, type TokenLimit } from '../rbac/rbac.service';
import { DownloadCache, type CachedFile } from './download-cache.service';
import { DEFAULT_MAX_BYTES, findPart, TERMINAL_PHASES, type ObjectKind, type Part } from './parts';

export type FetchState =
  | { state: 'cached'; fetchedAt: Date; expiresAt: Date; bytes: number }
  | { state: 'fetching'; command: CommandView };

/**
 * The files Velero keeps for a backup or restore — its log, results, resource list
 * and so on (PLAN.md §7.3). Reading one is two steps: `request` asks the agent to
 * fetch it (or says a fresh copy is already held), `read` serves the held copy.
 *
 * Both answer **404 for an object the caller may not see**, exactly as for one that
 * does not exist (ADR-024), and demand the file's own permission: a log names
 * resources, so `backup:logs` is separate from `backup:read`.
 */
@Injectable()
export class DownloadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly commands: CommandsService,
    private readonly cache: DownloadCache,
  ) {}

  /** Finds the object and the part, or 404 — the same 404 whatever the reason. */
  private async locate(
    orgId: string,
    userId: string,
    clusterId: string,
    kind: ObjectKind,
    name: string,
    slug: string,
    token: TokenLimit | undefined,
  ) {
    const part = findPart(kind, slug);
    const notFound = new NotFoundException(`${kind === 'BACKUP' ? 'backup' : 'restore'} not found`);
    if (part === undefined) {
      throw new NotFoundException('there is no such file for this object');
    }
    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.findFirst({ where: { clusterId, kind, name, deletedAt: null } }),
    );
    const visibility = await this.rbac.visibility(orgId, userId, clusterId, part.permission, token);
    if (row === null || !(visibility.all || visibility.sees(coveredBy(kind, row.spec)))) {
      throw notFound;
    }
    return {
      part,
      row,
      key: {
        orgId,
        clusterId,
        part: part.key,
        targetName: row.name,
        targetUid: row.uid,
      },
      finished: TERMINAL_PHASES.has(row.phase ?? ''),
    };
  }

  async request(
    orgId: string,
    userId: string,
    clusterId: string,
    kind: ObjectKind,
    name: string,
    slug: string,
    refresh: boolean,
    token?: TokenLimit,
  ): Promise<FetchState> {
    const { part, key, finished } = await this.locate(
      orgId,
      userId,
      clusterId,
      kind,
      name,
      slug,
      token,
    );

    if (!refresh) {
      const held = await this.held(key);
      if (held !== null) {
        return {
          state: 'cached',
          fetchedAt: held.fetchedAt,
          expiresAt: held.expiresAt,
          bytes: held.sizeBytes,
        };
      }
    }

    // One fetch at a time per file: a second click, or a second viewer, joins it.
    const running = await this.prisma.inOrg(orgId, () =>
      this.prisma.command.findFirst({
        where: {
          clusterId,
          op: 'FETCH_DOWNLOAD',
          status: { in: [...NON_TERMINAL] },
          deadlineAt: { gt: new Date() },
          AND: [
            { payload: { path: ['part'], equals: part.key } },
            { payload: { path: ['targetUid'], equals: key.targetUid } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (running !== null) {
      return { state: 'fetching', command: await this.commands.get(orgId, clusterId, running.id) };
    }

    const payload: Prisma.InputJsonObject = {
      part: part.key,
      targetName: key.targetName,
      targetUid: key.targetUid,
      maxBytes: DEFAULT_MAX_BYTES,
      finished,
    };
    return {
      state: 'fetching',
      command: await this.commands.enqueue(orgId, clusterId, userId, 'FETCH_DOWNLOAD', payload),
    };
  }

  /** The held copy, or `null` when none is held (never fetched, expired, or purged). */
  async read(
    orgId: string,
    userId: string,
    clusterId: string,
    kind: ObjectKind,
    name: string,
    slug: string,
    token?: TokenLimit,
  ): Promise<{ file: CachedFile | null; part: Part; name: string }> {
    const { part, key } = await this.locate(orgId, userId, clusterId, kind, name, slug, token);
    return { file: await this.held(key), part, name: key.targetName };
  }

  private held(key: Parameters<DownloadCache['get']>[0]): Promise<CachedFile | null> {
    return this.cache.get(key);
  }
}
