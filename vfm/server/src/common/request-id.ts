import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

/**
 * Request correlation (PLAN.md §10: "Every response includes an X-Request-Id
 * header").
 *
 * An inbound id is reused so a trace survives a reverse proxy, but only if it
 * looks like an id we would have generated — an attacker-controlled header
 * ends up in logs, audit rows and error bodies, so it must not be able to
 * carry arbitrary content (PLAN.md §12.1: validate at every boundary).
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Conservative shape: UUIDs and the hex/dash ids proxies commonly emit. */
const ACCEPTABLE_INBOUND_ID = /^[A-Za-z0-9._-]{8,128}$/;

declare module 'express' {
  interface Request {
    requestId?: string;
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header(REQUEST_ID_HEADER);
  const id = inbound !== undefined && ACCEPTABLE_INBOUND_ID.test(inbound) ? inbound : randomUUID();

  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

/** Reads the id assigned by {@link requestIdMiddleware}, if it has run. */
export function requestIdOf(req: Pick<Request, 'requestId'>): string | undefined {
  return req.requestId;
}
