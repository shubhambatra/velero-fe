import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  static as serveStatic,
} from 'express';

/** Paths the API and the probes own; the single-page-app fallback never answers them. */
const API_PREFIXES = ['/api/', '/healthz', '/readyz'];

export const isApiPath = (path: string): boolean =>
  path === '/api' || API_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));

/**
 * Serves the built web UI from `dir` (PLAN.md section 14, threat model G-5: the CSP is then the server's
 * own, not an ingress's). Hashed assets are cached for a year; `index.html` never is, so a release
 * is picked up at once. Any other GET that is not the API falls back to `index.html` so client-side
 * routes survive a reload. Returns false (and does nothing) when the directory has no `index.html`.
 */
export function mountWeb(app: Express, dir: string): boolean {
  const root = resolve(dir);
  const index = join(root, 'index.html');
  if (!existsSync(index) || !statSync(index).isFile()) {
    return false;
  }
  app.use(
    serveStatic(root, {
      index: false,
      setHeaders: (res, path) => {
        res.setHeader(
          'Cache-Control',
          path.includes(join(root, 'assets')) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(req.path)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  return true;
}
