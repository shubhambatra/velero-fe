import { Global, Module } from '@nestjs/common';
import { KubeRegistry } from './kube-registry.service';
import { KubeClients } from './kube-clients.service';

@Global()
@Module({
  providers: [KubeRegistry, KubeClients],
  exports: [KubeRegistry, KubeClients],
})
export class KubeModule {}
