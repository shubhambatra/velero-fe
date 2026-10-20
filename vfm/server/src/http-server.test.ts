import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { KEEP_ALIVE_MS, tuneHttpServer } from './http-server';

describe('tuneHttpServer', () => {
  it('outlasts a proxy that keeps its upstream connections for a minute', () => {
    const server = createServer();
    expect(server.keepAliveTimeout).toBe(5_000); // Node's default, which is the problem
    tuneHttpServer(server);
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_MS);
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
    server.close();
  });

  it('keeps headersTimeout above keepAliveTimeout', () => {
    const server = createServer();
    tuneHttpServer(server);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    server.close();
  });
});
