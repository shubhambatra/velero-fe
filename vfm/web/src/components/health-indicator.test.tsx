import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HealthIndicator } from '@/components/health-indicator';
import { jsonResponse, renderWithProviders, stubFetch } from '@/test/utils';

/**
 * The control plane is a separate deployable that may not be running at all
 * (PLAN.md §16 builds it in parallel), so all three states have to render
 * without the component throwing.
 */
describe('health indicator', () => {
  it('reports connected when both probes pass', async () => {
    stubFetch((url) =>
      url.endsWith('/readyz')
        ? jsonResponse({
            status: 'ok',
            checks: { postgres: { status: 'up' }, redis: { status: 'up' } },
          })
        : jsonResponse({ status: 'ok' }),
    );

    renderWithProviders(<HealthIndicator />);

    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('reports degraded, naming the failed dependency, when readiness fails', async () => {
    stubFetch((url) =>
      url.endsWith('/readyz')
        ? jsonResponse(
            { status: 'error', checks: { postgres: { status: 'up' }, redis: { status: 'down' } } },
            { status: 503 },
          )
        : jsonResponse({ status: 'ok' }),
    );

    renderWithProviders(<HealthIndicator />);

    const badge = await screen.findByText('Degraded');

    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('title') ?? '').toContain('redis');
  });

  it('reports unreachable when the control plane does not answer', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    renderWithProviders(<HealthIndicator />);

    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
  });

  it('renders a pending state immediately instead of blocking on the network', () => {
    // A probe that never settles: the first paint must still produce output.
    stubFetch(() => new Promise<Response>(() => undefined));

    renderWithProviders(<HealthIndicator />);

    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
