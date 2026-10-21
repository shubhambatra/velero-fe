import { Component, type ErrorInfo, type ReactNode } from 'react';

import { AlertIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last line of defence at the app root (PLAN.md §16, Day 3).
 *
 * A render crash must leave the operator with something actionable rather than
 * a blank page: what failed, the request id if the failure came from the API
 * (so it can be quoted against the server logs), and both ways out — retry
 * the render, or reload the app.
 *
 * Deliberately not reported anywhere yet. Shipping client errors to the
 * control plane is its own decision (endpoint, payload, redaction per §12.1)
 * and belongs with the observability work, not here.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The browser console is the only sink available in this increment.
    console.error('Unhandled render error', error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;

    if (error === null) {
      return this.props.children;
    }

    const requestId = error instanceof ApiError ? error.requestId : undefined;

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-lg" role="alert">
          <CardHeader>
            <CardTitle level={2} className="flex items-center gap-2">
              <AlertIcon className="h-5 w-5 text-error" aria-hidden="true" focusable="false" />
              Something went wrong
            </CardTitle>
            <CardDescription>
              The page could not be rendered. Nothing was submitted or changed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* React escapes this; §12.1 treats any server-derived text as untrusted. */}
            <p className="rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
              {error.message === '' ? error.name : error.message}
            </p>
            {requestId === undefined ? null : (
              <p className="text-sm text-muted-foreground">
                Request id: <span className="font-mono">{requestId}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={this.reset}>
                Try again
              </Button>
              <Button variant="outline" onClick={this.reload}>
                Reload the app
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
