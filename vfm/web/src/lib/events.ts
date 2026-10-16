import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

import { API_BASE_URL } from './api';

/**
 * Live updates over server-sent events (PLAN.md §10 `/stream`, §11.2).
 *
 * The stream carries **no data**, only "something changed on this cluster". On an
 * event the affected queries are re-read through the REST API, which applies the full
 * permission rules. That keeps one place deciding what a user may see, and means a
 * missed or dropped event costs at most a stale screen until the next read, never a
 * wrong one.
 *
 * Browsers reconnect a dropped stream themselves, but give up for good on an HTTP
 * error (sign-out, a full stream quota). Then this reconnects by hand with backoff,
 * and meanwhile the pages fall back to polling (see {@link useRefreshInterval}).
 */

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

let status: StreamStatus = 'offline';
const listeners = new Set<() => void>();

function setStatus(next: StreamStatus): void {
  if (status !== next) {
    status = next;
    for (const l of listeners) {
      l();
    }
  }
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const useStreamStatus = (): StreamStatus =>
  useSyncExternalStore(
    subscribe,
    () => status,
    () => 'offline',
  );

/**
 * How often a page re-reads on its own. Rare while the stream is live (a safety net
 * for a missed event), frequent when it is not, so a user never relies on a stream
 * that is not there.
 */
export function useRefreshInterval(): number {
  return useStreamStatus() === 'live' ? 120_000 : 15_000;
}

/** Query keys that the stream refreshes. `['org', orgId, <one of these>, ...]`. */
const LIVE_SECTIONS = new Set(['fleet', 'clusters', 'cluster']);

const DEBOUNCE_MS = 300;
const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

export interface StreamDeps {
  /** Injected so tests can drive a fake stream. */
  createSource?: (url: string) => EventSource;
  /** Injected so tests need not wait out the backoff. */
  backoffStartMs?: number;
}

/** Opens the stream for an organization and keeps it open until unmounted. */
export function useLiveUpdates(orgId: string | undefined, deps: StreamDeps = {}): void {
  const client = useQueryClient();
  useEffect(() => {
    if (orgId === undefined) {
      setStatus('offline');
      return undefined;
    }
    return openStream(orgId, client, deps);
    // `deps` is a test seam and is not expected to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, client]);
}

export function openStream(orgId: string, client: QueryClient, deps: StreamDeps = {}): () => void {
  const make =
    deps.createSource ?? ((url: string) => new EventSource(url, { withCredentials: true }));
  const url = `${API_BASE_URL}/stream`;
  let source: EventSource | undefined;
  let stopped = false;
  let backoff = deps.backoffStartMs ?? BACKOFF_START_MS;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const refresh = (): void => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void client.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === 'org' &&
          q.queryKey[1] === orgId &&
          LIVE_SECTIONS.has(String(q.queryKey[2])),
      });
    }, DEBOUNCE_MS);
  };

  const connect = (): void => {
    if (stopped) {
      return;
    }
    if (typeof EventSource === 'undefined' && deps.createSource === undefined) {
      setStatus('offline');
      return;
    }
    setStatus('connecting');
    const es = make(url);
    source = es;

    es.addEventListener('open', () => {
      backoff = deps.backoffStartMs ?? BACKOFF_START_MS;
      setStatus('live');
      // Anything that changed while the stream was down is only found by looking.
      refresh();
    });
    for (const type of ['cluster', 'inventory', 'command']) {
      es.addEventListener(type, refresh);
    }
    es.addEventListener('error', () => {
      if (stopped) {
        return;
      }
      if (es.readyState === 2 /* CLOSED */) {
        // The browser has given up (an HTTP error); try again ourselves, later.
        setStatus('offline');
        es.close();
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      } else {
        setStatus('reconnecting');
      }
    });
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(debounce);
    source?.close();
    setStatus('offline');
  };
}
