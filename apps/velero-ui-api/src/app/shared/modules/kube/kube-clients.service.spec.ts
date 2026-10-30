import { CoreV1Api } from '@kubernetes/client-node';
import { KubeClients } from './kube-clients.service';
import { runInKubeContext } from './kube-context';
import { KubeRegistry } from './kube-registry.service';

describe('KubeClients', () => {
  const configs = {
    a: { makeApiClient: jest.fn() },
    b: { makeApiClient: jest.fn() },
  };
  const registry = {
    get: jest.fn((name?: string) => configs[(name ?? 'a') as 'a' | 'b']),
  } as unknown as KubeRegistry;
  let clients: KubeClients;

  beforeEach(() => {
    jest.clearAllMocks();
    configs.a.makeApiClient.mockImplementation(() => ({ cluster: 'a' }));
    configs.b.makeApiClient.mockImplementation(() => ({ cluster: 'b' }));
    clients = new KubeClients(registry);
  });

  it('uses the context of the current request and falls back to the default', () => {
    expect(clients.api(CoreV1Api)).toEqual({ cluster: 'a' });
    expect(runInKubeContext('b', () => clients.api(CoreV1Api))).toEqual({
      cluster: 'b',
    });
  });

  it('never hands one cluster the client built for another', () => {
    const a = clients.api(CoreV1Api);
    const b = runInKubeContext('b', () => clients.api(CoreV1Api));
    expect(a).not.toBe(b);
  });

  it('builds a client once per context and API type', () => {
    clients.api(CoreV1Api);
    clients.api(CoreV1Api);
    expect(configs.a.makeApiClient).toHaveBeenCalledTimes(1);
  });

  it('prefers an explicit context over the request context', () => {
    expect(runInKubeContext('b', () => clients.api(CoreV1Api, 'a'))).toEqual({
      cluster: 'a',
    });
  });
});
