/**
 * Node closes an idle keep-alive connection after 5 seconds. A load balancer or ingress in front of the
 * control plane keeps its upstream connections for about a minute (AWS ALB 60 s, nginx 60 s by default), so
 * it will send the next request down a socket Node has just closed and the caller sees an intermittent
 * 502. The server must outlast the proxy, never the other way round.
 */
export const KEEP_ALIVE_MS = 65_000;

/** `headersTimeout` must exceed `keepAliveTimeout`, or Node can drop a connection between two requests. */
export function tuneHttpServer(server: { keepAliveTimeout: number; headersTimeout: number }): void {
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 1_000;
}
