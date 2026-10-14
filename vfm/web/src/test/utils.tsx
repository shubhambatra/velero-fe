import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi, type Mock } from 'vitest';

import { AppProviders } from '@/app/providers';
import { routeTree } from '@/router';

/**
 * A query client that makes tests deterministic: no retries, no background
 * refetching, nothing that depends on wall-clock time.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchInterval: false,
        staleTime: Infinity,
      },
    },
  });
}

export function renderWithProviders(
  ui: ReactElement,
  options: { queryClient?: QueryClient | undefined } = {},
): RenderResult {
  return render(
    <AppProviders queryClient={options.queryClient ?? createTestQueryClient()}>{ui}</AppProviders>,
  );
}

/** Mounts the real route tree against an in-memory history. */
export function renderApp(
  options: { path?: string; queryClient?: QueryClient | undefined } = {},
): RenderResult {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [options.path ?? '/'] }),
  });

  return renderWithProviders(<RouterProvider router={router} />, {
    queryClient: options.queryClient,
  });
}

/** `fetch` is the only network boundary; no test is allowed to cross it. */
export function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): Mock<typeof fetch> {
  const mock = vi.fn<typeof fetch>((input, init) => Promise.resolve(handler(urlOf(input), init)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

export function jsonResponse(
  body: unknown,
  options: { status?: number; contentType?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'Content-Type': options.contentType ?? 'application/json' },
  });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}
