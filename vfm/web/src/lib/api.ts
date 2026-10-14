/**
 * Typed HTTP client for the control plane REST API (PLAN.md §10).
 *
 * This is the hand-written increment. Once `server/openapi.yaml` is generated
 * and its types are emitted into `packages/shared` (PLAN.md §16, Day 3 lists
 * "API client generated from OpenAPI"), the request/response generics here are
 * replaced by those generated types — this module keeps the transport
 * concerns (base URL, credentials, request ids, RFC 9457 parsing) and stops
 * casting response bodies blindly. Generation is a separate task; nothing here
 * should grow hand-written resource types in the meantime.
 *
 * Deliberate properties, all of them security-relevant (PLAN.md §12.1):
 *  - every request is same-origin by default, because the control plane serves
 *    a CSP with `connect-src 'self'` and §1.1 P6 forbids third-party origins;
 *  - error bodies are narrowed field by field rather than trusted, because an
 *    error body can carry agent-supplied text and the agent is semi-trusted;
 *  - every request carries an `X-Request-Id` so a user-visible failure can be
 *    traced to a server log line.
 */

import { asString, isRecord } from './guards';

const DEFAULT_API_BASE_URL = '/api/v1';

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL;

/**
 * Base URL for versioned API routes. Relative by default: the browser talks
 * only to the origin that served the app.
 */
export const API_BASE_URL =
  configuredApiBaseUrl !== undefined && configuredApiBaseUrl !== ''
    ? stripTrailingSlash(configuredApiBaseUrl)
    : DEFAULT_API_BASE_URL;

/**
 * Base URL for routes that live at the deployment root rather than under the
 * API version prefix — the probes, which the control plane excludes from
 * `/api/v1` because orchestrators expect them at `/healthz` and `/readyz`.
 */
export const ROOT_BASE_URL = deriveRootBaseUrl(API_BASE_URL);

/** Matches `REQUEST_ID_HEADER` in server/src/common/request-id.ts. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** RFC 9457 media type, as emitted by the server's problem exception filter. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * Hard ceiling on every request. A control plane that accepts the connection
 * and then stalls must not leave a component spinning forever — the health
 * indicator in particular has to reach a terminal state (PLAN.md §11.2 asks
 * for states that explain themselves).
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** RFC 9457 problem document, mirroring server/src/common/problem.filter.ts. */
export interface ApiProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string | undefined;
  instance: string | undefined;
  requestId: string | undefined;
  errors: { path: string; message: string }[] | undefined;
}

/** Base class for every failure this client raises, so callers can catch once. */
export class ApiError extends Error {
  readonly requestId: string | undefined;

  constructor(message: string, requestId: string | undefined, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApiError';
    this.requestId = requestId;
  }
}

/** An error response the server described as an RFC 9457 problem document. */
export class ApiProblem extends ApiError {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly instance: string | undefined;
  readonly errors: { path: string; message: string }[] | undefined;

  constructor(problem: ApiProblemBody, requestId: string | undefined) {
    super(
      problem.detail !== undefined
        ? `${problem.status.toString()} ${problem.title}: ${problem.detail}`
        : `${problem.status.toString()} ${problem.title}`,
      problem.requestId ?? requestId,
    );
    this.name = 'ApiProblem';
    this.status = problem.status;
    this.type = problem.type;
    this.title = problem.title;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.errors = problem.errors;
  }

  /**
   * Text safe to put in front of a user. `title` is stable per problem type
   * and `detail` is written for the caller; nothing else is surfaced, and the
   * server already withholds internals on 5xx.
   */
  get userMessage(): string {
    return this.detail !== undefined ? `${this.title}: ${this.detail}` : this.title;
  }
}

/** The request never produced an HTTP response: offline, DNS, TLS, or timeout. */
export class ApiTransportError extends ApiError {
  readonly timedOut: boolean;

  constructor(message: string, requestId: string | undefined, timedOut: boolean, cause: unknown) {
    super(message, requestId, { cause });
    this.name = 'ApiTransportError';
    this.timedOut = timedOut;
  }
}

export interface ApiRequestOptions {
  method?: string;
  /** Serialised as JSON. Omit for GET. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Caller-owned cancellation, e.g. TanStack Query's signal. */
  signal?: AbortSignal;
  /** Pass through an existing correlation id instead of minting a new one. */
  requestId?: string;
  timeoutMs?: number;
  /** Defaults to {@link API_BASE_URL}; use {@link ROOT_BASE_URL} for the probes. */
  baseUrl?: string;
}

/**
 * A fresh correlation id. The server reuses an inbound id when it matches
 * `^[A-Za-z0-9._-]{8,128}$`, which a UUID does, so the id we generate here is
 * the one that appears in the server logs and in the response header.
 */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Performs the request and returns the raw {@link Response}, successful or
 * not. Callers that need the status code itself — the readiness probe answers
 * 503 with a meaningful body — use this; everything else uses
 * {@link apiFetch}.
 */
export async function apiRequest(
  path: string,
  options: ApiRequestOptions = {},
): Promise<{ response: Response; requestId: string }> {
  const { method = 'GET', body, headers, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const requestId = options.requestId ?? newRequestId();
  const url = resolveUrl(options.baseUrl ?? API_BASE_URL, path);

  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', `${PROBLEM_CONTENT_TYPE}, application/json`);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  if (body !== undefined) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const controller = new AbortController();
  // Held on an object rather than as a bare `let`: TypeScript narrows a local
  // boolean to `false` when its only assignment is inside a timer callback,
  // which makes every later read of it look like dead code.
  const timing = { timedOut: false };
  const timer = setTimeout(() => {
    timing.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      // Session cookies are the auth mechanism (PLAN.md §8), and they are
      // same-origin; sending them explicitly also keeps a configured absolute
      // API base working behind a reverse proxy.
      credentials: 'include',
      // Probe and fleet-status responses must never come from the HTTP cache.
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });

    return {
      response,
      // The server echoes the id it actually used; prefer it over ours.
      requestId: response.headers.get(REQUEST_ID_HEADER) ?? requestId,
    };
  } catch (cause: unknown) {
    // A caller-initiated abort is not a failure — let it propagate so
    // TanStack Query records a cancellation rather than an error.
    if (signal?.aborted === true && !timing.timedOut) {
      throw cause;
    }
    throw new ApiTransportError(
      timing.timedOut
        ? `Request to ${url} timed out after ${timeoutMs.toString()}ms`
        : `Request to ${url} failed: the control plane could not be reached`,
      requestId,
      timing.timedOut,
      cause,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * Performs the request and returns the decoded JSON body, throwing
 * {@link ApiProblem} for any non-2xx response.
 *
 * `T` is asserted, not validated — that is exactly what the OpenAPI-generated
 * types (and the zod schemas in `@vfm/shared`) will replace.
 */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { response, requestId } = await apiRequest(path, options);

  if (!response.ok) {
    throw new ApiProblem(await readProblem(response), requestId);
  }

  return (await readJson(response)) as T;
}

/**
 * Reads a JSON body, tolerating the empty ones: 204, and 200 with no payload.
 * Returns `undefined` in those cases, so `apiFetch<void>()` is the correct
 * generic for an endpoint that answers with no content.
 */
export async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return undefined;
  }
  const text = await response.text();
  if (text === '') {
    return undefined;
  }
  try {
    // `JSON.parse` is typed `any`; the assertion keeps that `any` from
    // escaping this module (the workspace lint config bans unsafe values).
    return JSON.parse(text) as unknown;
  } catch {
    // A body that claims JSON and is not — a proxy error page, a truncated
    // response — must not take the caller down with a SyntaxError.
    return undefined;
  }
}

/**
 * Turns an error response into a problem document.
 *
 * Every field is checked individually: a proxy, a crash page or a hostile
 * payload can all produce a body that claims the right media type, and the
 * UI still has to render something sensible.
 */
async function readProblem(response: Response): Promise<ApiProblemBody> {
  const body = await readJson(response);
  const record: Record<string, unknown> = isRecord(body) ? body : {};

  return {
    type: stringOr(record.type, 'about:blank'),
    title: stringOr(record.title, fallbackTitle(response)),
    // The status line is authoritative; a body claiming otherwise is wrong.
    status: response.status,
    detail: asString(record.detail),
    instance: asString(record.instance),
    requestId: asString(record.requestId),
    errors: parseValidationErrors(record.errors),
  };
}

function fallbackTitle(response: Response): string {
  return response.statusText !== '' ? response.statusText : `HTTP ${response.status.toString()}`;
}

function parseValidationErrors(value: unknown): { path: string; message: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const errors = value.filter(isRecord).map((entry) => ({
    path: stringOr(entry.path, ''),
    message: stringOr(entry.message, ''),
  }));
  return errors.length > 0 ? errors : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return asString(value) ?? fallback;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
}

/**
 * Joins base and path, and refuses an absolute path outright: a request to
 * another origin would be blocked by the CSP at runtime anyway, and silently
 * allowing one here is how air-gap violations (§1.1 P6) get introduced.
 */
function resolveUrl(baseUrl: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
    throw new Error(`API paths must be relative to the configured base URL, got: ${path}`);
  }
  return `${stripTrailingSlash(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

/** `https://host/api/v1` → `https://host`; a relative base → the origin root. */
function deriveRootBaseUrl(apiBaseUrl: string): string {
  if (!/^https?:\/\//i.test(apiBaseUrl)) {
    return '';
  }
  return stripTrailingSlash(new URL('/', apiBaseUrl).toString());
}
