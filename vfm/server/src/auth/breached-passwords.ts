import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

/**
 * The bundled breached-password list required by PLAN.md §8.3:
 * "breached-password check against a bundled top-100k list, **no external
 * calls**".
 *
 * That last clause is the design constraint. A Pwned Passwords API lookup —
 * even the k-anonymity range query — is an outbound call to the public
 * internet, which §1.1 P6 forbids outright for an air-gapped install. So the
 * list ships with the image.
 *
 * `data/breached-passwords.txt.gz` is the UK NCSC's published top-100k list
 * (via SecLists), normalised to lower case and deduplicated: 97 747 entries,
 * 260 KB compressed. Normalising is what makes the check case-insensitive, so
 * `Password123` is rejected along with `password123` — users reliably reach
 * for capitalisation to satisfy a complexity rule, and it buys nothing against
 * a dictionary attack.
 *
 * Held in memory as a Set: ~6 MB of heap for an O(1) check on a request path
 * that must not touch the disk. Loaded once at startup, before the service
 * reports ready.
 */
@Injectable()
export class BreachedPasswordsService implements OnModuleInit {
  private readonly logger = new Logger(BreachedPasswordsService.name);
  private passwords = new Set<string>();

  async onModuleInit(): Promise<void> {
    this.passwords = await loadList();
    this.logger.log(`loaded ${this.passwords.size.toString()} breached passwords`);
  }

  /**
   * Whether the password appears in the bundled list.
   *
   * Compares the lower-cased candidate, matching how the list was normalised.
   */
  isBreached(password: string): boolean {
    return this.passwords.has(password.toLowerCase());
  }

  /** Entry count, for the readiness check and for tests. */
  get size(): number {
    return this.passwords.size;
  }
}

/**
 * The bundled list lives beside this file. It is referenced relative to
 * `__dirname` so it resolves identically from `src/` under tsx and from
 * `dist/` in the built image; the build copies `src/auth/data` across.
 */
export const BREACHED_LIST_PATH = join(__dirname, 'data', 'breached-passwords.txt.gz');

export async function loadList(path: string = BREACHED_LIST_PATH): Promise<Set<string>> {
  // Checked before opening the stream. `createReadStream` reports a missing
  // file by emitting 'error' asynchronously, and that error does not surface
  // through the readline async iterator — the load would hang instead of
  // failing, which is the worst outcome for something on the startup path.
  if (!existsSync(path)) {
    throw new Error(
      `breached-password list not found at ${path}. ` +
        'It is a shipped asset: check that the build copied src/auth/data.',
    );
  }

  const passwords = new Set<string>();

  // `pipeline` propagates an error from any stage, so a truncated or
  // non-gzip file rejects rather than yielding a short list.
  const source = createReadStream(path);
  const gunzip = createGunzip();
  const decompressed = pipeline(source, gunzip, () => {
    // Errors are surfaced by awaiting `finished` below; this callback exists
    // only because the callback form of pipeline requires it.
  });

  const lines = createInterface({ input: decompressed, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line !== '') {
      passwords.add(line);
    }
  }

  await finished(decompressed);

  if (passwords.size === 0) {
    // An empty list would silently disable the check, which is worse than
    // failing to start (PLAN.md §0 rule 7).
    throw new Error(`breached-password list at ${path} is empty`);
  }

  return passwords;
}
