import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { httpDuration } from './metrics';

/**
 * Times every REST request, labelled by the **route template** (`/orgs/:orgId/clusters/:clusterId`),
 * never the URL, so the label set stays as small as the API. Unmatched requests (scanners, typos) are
 * one `unmatched` series. The event stream is left out: it is open for hours and has its own gauge.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const route = (req.route as { path?: string } | undefined)?.path;
      // With nothing matched, the last route Express saw is this middleware's own wildcard.
      const template =
        route === undefined || route.includes('*') ? 'unmatched' : `${req.baseUrl}${route}`;
      if (template.endsWith('/stream')) return;
      httpDuration.observe(
        {
          method: req.method,
          route: template,
          status_class: `${Math.floor(res.statusCode / 100).toString()}xx`,
        },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
    });
    next();
  }
}
