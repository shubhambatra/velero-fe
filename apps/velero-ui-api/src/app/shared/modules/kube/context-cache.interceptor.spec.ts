import { ExecutionContext } from '@nestjs/common';
import { ContextCacheInterceptor } from './context-cache.interceptor';
import { runInKubeContext } from './kube-context';

describe('ContextCacheInterceptor', () => {
  const request = { method: 'GET', url: '/api/backups' };
  const reflector = {
    get: () => undefined,
    getAllAndOverride: () => undefined,
  };
  const interceptor = new ContextCacheInterceptor(
    {} as never,
    reflector as never
  );
  // Property-injected by Nest: the HTTP adapter the base class derives the URL key from.
  Object.assign(interceptor, {
    httpAdapterHost: {
      httpAdapter: {
        getRequestMethod: (r: typeof request) => r.method,
        getRequestUrl: (r: typeof request) => r.url,
      },
    },
  });
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getArgByIndex: () => request,
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  const key = (cluster?: string) =>
    runInKubeContext(cluster, () =>
      (
        interceptor as never as {
          trackBy(c: ExecutionContext): Promise<string>;
        }
      ).trackBy(context)
    );

  it('gives the same URL a different cache key per cluster', async () => {
    const [a, b, none] = [await key('a'), await key('b'), await key()];
    expect(new Set([a, b, none]).size).toBe(3);
    expect(a).toContain('/api/backups');
  });
});
