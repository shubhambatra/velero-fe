import { Injectable } from '@nestjs/common';
import { ApiConstructor, ApiType, KubeConfig, Watch } from '@kubernetes/client-node';
import { currentKubeContext } from './kube-context';
import { KubeRegistry } from './kube-registry.service';

/**
 * Kubernetes clients for the cluster context selected by the current request (or an explicit
 * one, for sockets). Clients are cached per KubeConfig, so switching contexts never reuses
 * another cluster's connection.
 */
@Injectable()
export class KubeClients {
  private readonly apis = new WeakMap<KubeConfig, Map<unknown, unknown>>();

  constructor(private readonly registry: KubeRegistry) {}

  public config(context?: string): KubeConfig {
    return this.registry.get(context ?? currentKubeContext());
  }

  public api<T extends ApiType>(type: ApiConstructor<T>, context?: string): T {
    const kc = this.config(context);
    let byType = this.apis.get(kc);
    if (!byType) {
      byType = new Map();
      this.apis.set(kc, byType);
    }
    if (!byType.has(type)) {
      byType.set(type, kc.makeApiClient(type));
    }
    return byType.get(type) as T;
  }

  public watch(context?: string): Watch {
    return new Watch(this.config(context));
  }
}
