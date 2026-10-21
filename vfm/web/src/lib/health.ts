import { queryOptions } from '@tanstack/react-query';

import { apiRequest, ApiTransportError, readJson, ROOT_BASE_URL } from './api';
import { isRecord } from './guards';

/**
 * Control plane connectivity for the header indicator (PLAN.md §11.1 shows
 * live connection status; §10 defines the probes).
 *
 * The two probes mean different things and the UI must not conflate them:
 *  - `/healthz` answers "the process is up";
 *  - `/readyz` answers "Postgres and Redis are reachable", with 503 and a body
 *    naming the failed dependency.
 *
 * So: both fine → connected, process up but a dependency down → degraded,
 * no HTTP response at all → unreachable. The server is a separate deployable
 * and may simply not be running (during local development it usually isn't
 * yet), which is a normal state to render, not an error to throw.
 */
export type HealthState = 'connected' | 'degraded' | 'unreachable';

export interface HealthSnapshot {
  state: HealthState;
  /** One sentence explaining the state, for the tooltip and screen readers. */
  detail: string;
  /** Epoch milliseconds, so the caller can render "checked 5s ago". */
  checkedAt: number;
  /** Correlation id of the probe, quotable in a support request. */
  requestId: string | undefined;
}

export const HEALTH_QUERY_KEY = ['control-plane', 'health'] as const;

/** Probes must settle quickly; a slow answer is as useless as none. */
const HEALTH_TIMEOUT_MS = 5_000;

const HEALTH_REFETCH_MS = 15_000;

/** Dependency names are rendered, so only well-formed keys are shown. */
const SAFE_DEPENDENCY_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

interface ProbeResult {
  reachable: boolean;
  ok: boolean;
  timedOut: boolean;
  body: unknown;
  requestId: string | undefined;
}

/**
 * Resolves to a snapshot in every case except caller cancellation, which is
 * re-thrown so TanStack Query records it as a cancellation. Nothing here can
 * reject with a network error, which is what keeps the indicator from
 * surfacing an error boundary over a control plane that is merely down.
 */
export async function fetchHealth(options: { signal?: AbortSignal } = {}): Promise<HealthSnapshot> {
  const [liveness, readiness] = await Promise.all([
    probe('/healthz', options.signal),
    probe('/readyz', options.signal),
  ]);

  const checkedAt = Date.now();
  const requestId = liveness.requestId ?? readiness.requestId;

  if (!liveness.reachable) {
    return {
      state: 'unreachable',
      detail: liveness.timedOut
        ? 'The control plane did not answer the liveness probe in time.'
        : 'The control plane could not be reached.',
      checkedAt,
      requestId,
    };
  }

  if (!liveness.ok) {
    return {
      state: 'unreachable',
      detail: 'The control plane answered the liveness probe with a failure.',
      checkedAt,
      requestId,
    };
  }

  if (readiness.reachable && readiness.ok) {
    return { state: 'connected', detail: 'The control plane is ready.', checkedAt, requestId };
  }

  return {
    state: 'degraded',
    detail:
      describeFailedDependencies(readiness.body) ??
      'The control plane is running but not ready to serve traffic.',
    checkedAt,
    requestId,
  };
}

export const healthQueryOptions = queryOptions({
  queryKey: HEALTH_QUERY_KEY,
  queryFn: ({ signal }) => fetchHealth({ signal }),
  // `fetchHealth` already encodes failure as data, so a retry would only
  // delay showing the user what is going on.
  retry: false,
  refetchInterval: HEALTH_REFETCH_MS,
  staleTime: HEALTH_REFETCH_MS,
});

async function probe(path: string, signal: AbortSignal | undefined): Promise<ProbeResult> {
  try {
    const { response, requestId } = await apiRequest(path, {
      // The probes sit at the deployment root, outside the /api/v1 prefix.
      baseUrl: ROOT_BASE_URL,
      timeoutMs: HEALTH_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });

    return {
      reachable: true,
      ok: response.ok,
      timedOut: false,
      body: await readJson(response),
      requestId,
    };
  } catch (error: unknown) {
    if (error instanceof ApiTransportError) {
      return {
        reachable: false,
        ok: false,
        timedOut: error.timedOut,
        body: undefined,
        requestId: error.requestId,
      };
    }
    // A caller-initiated abort, or a programming error — neither is a
    // statement about the control plane's health.
    throw error;
  }
}

/** Reads `{ checks: { postgres: { status: 'down' } } }` from the readiness body. */
function describeFailedDependencies(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const checks: unknown = body.checks;
  if (!isRecord(checks)) {
    return undefined;
  }

  const down = Object.entries(checks)
    .filter(
      ([name, check]) =>
        SAFE_DEPENDENCY_NAME.test(name) && isRecord(check) && check.status === 'down',
    )
    .map(([name]) => name);

  return down.length > 0 ? `Dependencies unavailable: ${down.join(', ')}.` : undefined;
}
