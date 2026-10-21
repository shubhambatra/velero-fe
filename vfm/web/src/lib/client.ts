/**
 * Session-aware wrapper over {@link apiFetch}: CSRF double-submit and the
 * sudo re-authentication retry (PLAN.md §8.3).
 *
 * Nothing here stores a credential. The session cookie is HttpOnly and the
 * CSRF cookie is read from `document.cookie` on every request, never cached.
 */

import { ApiProblem, apiFetch, type ApiRequestOptions } from './api';

export const CSRF_COOKIE = 'vfm_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function readCsrfToken(): string | undefined {
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Resolves true once the sudo window is open, false if the user gave up. */
export type SudoPrompt = () => Promise<boolean>;

let sudoPrompt: SudoPrompt | null = null;

/** Called by the sudo dialog provider; returns an unregister function. */
export function registerSudoPrompt(prompt: SudoPrompt): () => void {
  sudoPrompt = prompt;
  return () => {
    if (sudoPrompt === prompt) {
      sudoPrompt = null;
    }
  };
}

function withCsrf(options: ApiRequestOptions): ApiRequestOptions {
  const method = (options.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return options;
  }
  const token = readCsrfToken();
  if (token === undefined) {
    return options;
  }
  return { ...options, headers: { ...options.headers, [CSRF_HEADER]: token } };
}

/**
 * Typed request. On a 403 with `sudoRequired` it asks the user to
 * re-authenticate and repeats the request exactly once.
 */
export async function api<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  try {
    return await apiFetch<T>(path, withCsrf(options));
  } catch (error: unknown) {
    if (
      error instanceof ApiProblem &&
      error.status === 403 &&
      error.sudoRequired &&
      sudoPrompt !== null &&
      (await sudoPrompt())
    ) {
      return apiFetch<T>(path, withCsrf(options));
    }
    throw error;
  }
}

/** Text to show for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiProblem) {
    return error.detail ?? error.title;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
