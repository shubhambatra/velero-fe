import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState, type ReactElement, type ReactNode } from 'react';

import { ErrorBoundary } from '@/components/error-boundary';
import { ThemeProvider } from '@/components/theme/theme-provider';

import { createQueryClient } from './query-client';

/**
 * Everything the app needs above the router.
 *
 * Order matters: the theme sits outside the error boundary so the crash
 * fallback is rendered in the user's theme, and the error boundary sits above
 * the query provider so a render failure inside any data-driven component is
 * caught here (PLAN.md §16, Day 3).
 */
export function AppProviders({
  children,
  queryClient,
}: {
  children: ReactNode;
  /** Tests inject a client with retries disabled. */
  queryClient?: QueryClient | undefined;
}): ReactElement {
  const [fallbackClient] = useState(createQueryClient);

  return (
    <ThemeProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient ?? fallbackClient}>{children}</QueryClientProvider>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
