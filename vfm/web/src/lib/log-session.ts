import { useCallback, useEffect, useRef, useState } from 'react';

import { API_BASE_URL } from './api';
import { api, CSRF_HEADER, errorMessage, readCsrfToken } from './client';
import { LineBuffer } from './log-buffer';

/** What a live view is of: one container of one pod (PLAN.md §7.3). */
export interface LogTarget {
  namespace: string;
  pod: string;
  container?: string;
}

export interface LogOptions {
  tailLines: number;
  previous: boolean;
  timestamps: boolean;
}

export const DEFAULT_LOG_OPTIONS: LogOptions = {
  tailLines: 200,
  previous: false,
  timestamps: false,
};

export type LogPhase =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'streaming' }
  | { phase: 'refused'; message: string }
  | { phase: 'ended'; reason: string; message: string }
  | { phase: 'lost' };

/** Why a session ended, in words for a person. */
export const END_REASONS: Record<string, string> = {
  stopped: 'You stopped the log.',
  completed: 'The container’s log has been read to its end.',
  pod_gone: 'The pod or container no longer exists.',
  timeout: 'The session reached its 30-minute limit.',
  idle: 'No one was watching the log for a while, so it was ended.',
  evicted: 'The agent was already serving its limit of log sessions and ended the oldest.',
  denied: 'The agent’s policy does not allow logs from this namespace.',
  revoked: 'Your permission to read logs here was removed.',
  error: 'The agent could not read the log.',
};

export interface Snapshot {
  lines: readonly string[];
  pending: string;
  /** Lines that fell off the front of the buffer. */
  dropped: number;
  total: number;
}

const EMPTY: Snapshot = { lines: [], pending: '', dropped: 0, total: 0 };
/** Chunks are batched so a busy log costs one render per interval, not one per chunk. */
const FLUSH_MS = 100;

interface Started {
  sessionId: string;
  streamUrl: string;
}

export interface LiveLog {
  state: LogPhase;
  snapshot: Snapshot;
  start: (options: LogOptions) => void;
  stop: () => void;
  clear: () => void;
  /** The whole buffer as text, for download. */
  text: () => string;
}

function sessionsPath(orgId: string, clusterId: string): string {
  return `/orgs/${orgId}/clusters/${clusterId}/log-sessions`;
}

/**
 * Runs one live log view: starts a session, follows its event stream into a bounded
 * buffer, and ends the session when the view goes away (closing the stream, asking the
 * server to stop, and again from `pagehide` for a closed tab).
 *
 * Nothing is reconnected silently: the control plane keeps no log, so lines produced
 * while a stream is down are gone, and the view says so instead of hiding the gap.
 */
export function useLiveLog(orgId: string, clusterId: string, target: LogTarget): LiveLog {
  const [state, setState] = useState<LogPhase>({ phase: 'idle' });
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const buffer = useRef(new LineBuffer());
  const source = useRef<EventSource | null>(null);
  const sessionId = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every start and stop, so a late answer to an old request is ignored.
  const generation = useRef(0);

  const flush = useCallback(() => {
    timer.current = null;
    const b = buffer.current;
    setSnapshot({ lines: b.lines, pending: b.pending, dropped: b.dropped, total: b.total });
  }, []);

  const schedule = useCallback(() => {
    timer.current ??= setTimeout(flush, FLUSH_MS);
  }, [flush]);

  const release = useCallback(
    (tellServer: boolean) => {
      generation.current += 1;
      source.current?.close();
      source.current = null;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const id = sessionId.current;
      sessionId.current = null;
      if (tellServer && id !== null) {
        // Best effort: the control plane also ends a session nobody is watching.
        void api(`${sessionsPath(orgId, clusterId)}/${id}`, { method: 'DELETE' }).catch(
          () => undefined,
        );
      }
    },
    [orgId, clusterId],
  );

  const stop = useCallback(() => {
    const was = sessionId.current !== null || source.current !== null;
    release(true);
    flush();
    if (was) {
      setState({ phase: 'ended', reason: 'stopped', message: '' });
    }
  }, [release, flush]);

  const start = useCallback(
    (options: LogOptions) => {
      release(true);
      buffer.current.clear();
      setSnapshot(EMPTY);
      setState({ phase: 'starting' });
      const mine = generation.current;
      api<Started>(sessionsPath(orgId, clusterId), {
        method: 'POST',
        body: {
          namespace: target.namespace,
          pod: target.pod,
          ...(target.container === undefined ? {} : { container: target.container }),
          tailLines: options.tailLines,
          previous: options.previous,
          timestamps: options.timestamps,
        },
      })
        .then((started) => {
          if (generation.current !== mine) {
            // Stopped or restarted while the request was in flight.
            void api(`${sessionsPath(orgId, clusterId)}/${started.sessionId}`, {
              method: 'DELETE',
            }).catch(() => undefined);
            return;
          }
          sessionId.current = started.sessionId;
          const events = new EventSource(
            `${API_BASE_URL}/orgs/${orgId}/clusters/${clusterId}/${started.streamUrl}`,
            { withCredentials: true },
          );
          source.current = events;
          events.onopen = () => {
            if (generation.current === mine) setState({ phase: 'streaming' });
          };
          events.addEventListener('chunk', (event) => {
            if (generation.current !== mine) return;
            try {
              const body = JSON.parse((event as MessageEvent<string>).data) as { text?: unknown };
              if (typeof body.text === 'string') {
                buffer.current.push(body.text);
                setState((s) => (s.phase === 'streaming' ? s : { phase: 'streaming' }));
                schedule();
              }
            } catch {
              // A chunk that is not JSON is not ours to show.
            }
          });
          events.addEventListener('ended', (event) => {
            if (generation.current !== mine) return;
            let reason = 'error';
            let message = '';
            try {
              const body = JSON.parse((event as MessageEvent<string>).data) as {
                reason?: unknown;
                message?: unknown;
              };
              reason = typeof body.reason === 'string' ? body.reason : 'error';
              message = typeof body.message === 'string' ? body.message : '';
            } catch {
              // Keep the defaults.
            }
            events.close();
            source.current = null;
            sessionId.current = null;
            if (timer.current !== null) clearTimeout(timer.current);
            flush();
            setState({ phase: 'ended', reason, message });
          });
          events.onerror = () => {
            if (generation.current !== mine) return;
            // EventSource would retry on its own, into a session that may be gone and
            // with a gap it cannot fill. Stop, and let the person decide.
            events.close();
            source.current = null;
            flush();
            setState({ phase: 'lost' });
          };
        })
        .catch((error: unknown) => {
          if (generation.current === mine) {
            setState({ phase: 'refused', message: errorMessage(error) });
          }
        });
    },
    [orgId, clusterId, target.namespace, target.pod, target.container, release, flush, schedule],
  );

  // Leaving the view (or switching target) ends the session.
  useEffect(() => {
    return () => {
      release(true);
    };
  }, [release, target.namespace, target.pod, target.container]);

  // Closing the tab does not run React cleanup; ask the server to stop, with the request
  // allowed to outlive the page.
  useEffect(() => {
    const onHide = (): void => {
      const id = sessionId.current;
      if (id === null) return;
      const token = readCsrfToken();
      void fetch(`${API_BASE_URL}${sessionsPath(orgId, clusterId)}/${id}`, {
        method: 'DELETE',
        keepalive: true,
        credentials: 'include',
        headers: token === undefined ? {} : { [CSRF_HEADER]: token },
      }).catch(() => undefined);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
    };
  }, [orgId, clusterId]);

  const clear = useCallback(() => {
    buffer.current.clear();
    setSnapshot(EMPTY);
  }, []);

  return { state, snapshot, start, stop, clear, text: () => buffer.current.text() };
}
