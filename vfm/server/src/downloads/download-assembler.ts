import { createHash } from 'node:crypto';

import type { LogChunk } from '../gateway/pb/vfm/agent/v1/logs';

/** What the agent sends with the result: how much, and its checksum. */
export interface Summary {
  bytesSent: number;
  sha256Hex: string;
}

export const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_PER_CLUSTER = 4;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const IDLE_MS = 2 * 60_000;

interface Assembly {
  clusterId: string;
  limit: number;
  chunks: Buffer[];
  bytes: number;
  next: number;
  complete: boolean;
  touchedAt: number;
  /** Set when the stream broke a rule; the result then fails, whatever it says. */
  broken: string | undefined;
}

export type Finished = { ok: true; data: Buffer } | { ok: false; reason: string };

/**
 * Puts the chunks of one `FetchDownload` back together, in memory, on the replica
 * that holds the agent's stream (chunks arrive on it, in order, before the result).
 *
 * The agent is semi-trusted, so everything it says is bounded: a chunk is at most
 * 64 KiB, a download at most the size the command asked for, each cluster has a few
 * downloads at once, and the replica holds a fixed total. A chunk out of sequence,
 * a different size from the one promised or a wrong checksum fails the download —
 * a log that is quietly missing a piece is worse than none.
 */
export class DownloadAssembler {
  private readonly assemblies = new Map<string, Assembly>();
  private total = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether a download of this command is being assembled. */
  has(commandId: string): boolean {
    return this.assemblies.has(commandId);
  }

  /**
   * Starts (or restarts, after an agent retry) the assembly of a command. The
   * caller has already checked the command is this cluster's and running.
   */
  start(commandId: string, clusterId: string, limit: number): string | undefined {
    this.drop(commandId);
    const mine = [...this.assemblies.values()].filter((a) => a.clusterId === clusterId).length;
    if (mine >= MAX_PER_CLUSTER) {
      return 'this cluster has too many downloads in progress';
    }
    this.assemblies.set(commandId, {
      clusterId,
      limit,
      chunks: [],
      bytes: 0,
      next: 0,
      complete: false,
      touchedAt: this.now(),
      broken: undefined,
    });
    return undefined;
  }

  /** Adds one chunk. Anything wrong breaks the assembly rather than throwing. */
  add(commandId: string, chunk: LogChunk): void {
    const a = this.assemblies.get(commandId);
    if (a === undefined || a.broken !== undefined) {
      return;
    }
    a.touchedAt = this.now();
    if (a.complete) {
      a.broken = 'data after the end marker';
    } else if (chunk.sequence !== a.next) {
      a.broken = `chunk ${chunk.sequence.toString()} arrived where ${a.next.toString()} was expected`;
    } else if (chunk.data.length > MAX_CHUNK_BYTES) {
      a.broken = 'a chunk was larger than allowed';
    } else if (a.bytes + chunk.data.length > a.limit) {
      a.broken = 'the file is larger than the limit';
    } else if (this.total + chunk.data.length > MAX_TOTAL_BYTES) {
      a.broken = 'the control plane is holding too many downloads';
    }
    if (a.broken !== undefined) {
      this.release(a);
      return;
    }
    a.chunks.push(Buffer.from(chunk.data));
    a.bytes += chunk.data.length;
    this.total += chunk.data.length;
    a.next += 1;
    a.complete = chunk.eof;
  }

  /** Verifies the assembly against what the agent says it sent, and hands over the bytes. */
  finish(commandId: string, summary: Summary): Finished {
    const a = this.assemblies.get(commandId);
    if (a === undefined) {
      return { ok: false, reason: 'no data arrived for the download' };
    }
    const data = Buffer.concat(a.chunks);
    const broken = a.broken;
    const complete = a.complete;
    this.drop(commandId);

    if (broken !== undefined) {
      return { ok: false, reason: broken };
    }
    if (!complete) {
      return { ok: false, reason: 'the data stopped before the end marker' };
    }
    if (data.length !== summary.bytesSent) {
      return { ok: false, reason: 'the size received differs from the size sent' };
    }
    if (createHash('sha256').update(data).digest('hex') !== summary.sha256Hex.toLowerCase()) {
      return { ok: false, reason: 'the checksum of the data received does not match' };
    }
    return { ok: true, data };
  }

  drop(commandId: string): void {
    const a = this.assemblies.get(commandId);
    if (a !== undefined) {
      this.release(a);
      this.assemblies.delete(commandId);
    }
  }

  /** Discards assemblies nothing has touched for a while (a command that never finished). */
  expire(): number {
    const cutoff = this.now() - IDLE_MS;
    let count = 0;
    for (const [id, a] of this.assemblies) {
      if (a.touchedAt < cutoff) {
        this.drop(id);
        count += 1;
      }
    }
    return count;
  }

  private release(a: Assembly): void {
    this.total -= a.bytes;
    a.chunks = [];
    a.bytes = 0;
  }
}
