import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { newId } from '../common/uuid';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { LIVE_COPY_SECONDS } from './parts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const PURGE_EVERY_MS = 10 * 60_000;

export interface FileKey {
  orgId: string;
  clusterId: string;
  part: string;
  targetName: string;
  targetUid: string;
}

export interface CachedFile {
  data: Buffer;
  fetchedAt: Date;
  expiresAt: Date;
  sizeBytes: number;
}

/**
 * Fetched backup/restore files, kept in PostgreSQL gzipped (PLAN.md §7.3). A copy of
 * a finished object lives for the configured number of days; a copy of one that is
 * still running for a few seconds only, because its files are still growing.
 */
@Injectable()
export class DownloadCache implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DownloadCache.name);
  private timer: NodeJS.Timeout | undefined;
  private readonly ttlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    this.ttlSeconds = env.DOWNLOAD_CACHE_TTL_DAYS * 86_400;
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.purge().catch((error: unknown) => {
        this.logger.warn(
          `could not purge expired files: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
    }, PURGE_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Seconds a copy of a file of an object in this state may be kept. */
  retentionSeconds(finished: boolean): number {
    return finished ? this.ttlSeconds : LIVE_COPY_SECONDS;
  }

  /** The copy, or `null` when there is none or it has expired. */
  async get(key: FileKey): Promise<CachedFile | null> {
    const row = await this.prisma.inOrg(key.orgId, () =>
      this.prisma.veleroFile.findFirst({
        where: {
          clusterId: key.clusterId,
          part: key.part,
          targetName: key.targetName,
          targetUid: key.targetUid,
          expiresAt: { gt: new Date() },
        },
      }),
    );
    if (row === null) {
      return null;
    }
    return {
      data: await gunzipAsync(row.content),
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
      sizeBytes: row.sizeBytes,
    };
  }

  /** Replaces the copy. A retention of zero stores nothing (caching switched off). */
  async put(
    key: FileKey,
    data: Buffer,
    sha256: string,
    commandId: string,
    retentionSeconds: number,
  ): Promise<void> {
    if (retentionSeconds <= 0) {
      return;
    }
    // Prisma wants a plain ArrayBuffer-backed view, not Node's pooled Buffer type.
    const content = new Uint8Array(await gzipAsync(data));
    const now = new Date();
    const fields = {
      content,
      sizeBytes: data.length,
      sha256,
      commandId,
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + retentionSeconds * 1000),
    };
    await this.prisma.inOrg(key.orgId, () =>
      this.prisma.veleroFile.upsert({
        where: {
          clusterId_part_targetName_targetUid: {
            clusterId: key.clusterId,
            part: key.part,
            targetName: key.targetName,
            targetUid: key.targetUid,
          },
        },
        create: { id: newId(), ...key, ...fields },
        update: fields,
      }),
    );
  }

  /** Deletes expired copies. Idempotent, so every replica may run it. */
  async purge(): Promise<number> {
    const result = await this.prisma.unscoped('expired cached files span every org', () =>
      this.prisma.veleroFile.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    );
    return result.count;
  }
}
