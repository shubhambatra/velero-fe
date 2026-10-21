import { createServer, type Server } from 'node:http';

import { Logger } from '@nestjs/common';
// PLAN.md §4.2 names prom-client; that package is deprecated in favour of this
// rename by the same project. See docs/DECISIONS.md ADR-006.
import { collectDefaultMetrics, Registry } from '@prometheus-io/client';

import { PRODUCT_SLUG } from '@vfm/shared';

/**
 * Prometheus metrics on a dedicated listener.
 *
 * PLAN.md §10 requires `/metrics` on a separate port (9090) that is not
 * exposed publicly. Keeping it off the main HTTP server means an Ingress
 * mistake cannot publish it, and it stays scrapeable while the API itself is
 * rejecting traffic.
 *
 * The metrics named in PLAN.md §13 (connected agents, command counts and
 * latency by type and status, stream reconnects, SSE subscribers, HTTP
 * latency, job queue depth) are registered by the modules that own them as
 * those modules are built. This file owns only the registry and the listener.
 */
export const metricsRegistry = new Registry();

metricsRegistry.setDefaultLabels({ service: `${PRODUCT_SLUG}-control-plane` });
collectDefaultMetrics({ register: metricsRegistry, prefix: `${PRODUCT_SLUG}_` });

export function startMetricsServer(host: string, port: number): Server {
  const logger = new Logger('MetricsServer');

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url === undefined || !req.url.startsWith('/metrics')) {
      res.writeHead(404).end();
      return;
    }

    metricsRegistry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'Content-Type': metricsRegistry.contentType }).end(body);
      })
      .catch((error: unknown) => {
        logger.error(`failed to collect metrics: ${error instanceof Error ? error.message : ''}`);
        res.writeHead(500).end();
      });
  });

  // A scrape that hangs must not hold a socket open indefinitely.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  server.listen(port, host, () => {
    logger.log(`metrics listening on ${host}:${port.toString()}`);
  });

  return server;
}
