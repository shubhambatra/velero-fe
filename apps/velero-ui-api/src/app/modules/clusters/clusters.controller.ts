import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { VersionApi } from '@kubernetes/client-node';
import { Action } from '@velero-ui/shared-types';
import { Resources } from '@velero-ui/velero';
import { CheckPolicies } from '@velero-ui-api/shared/decorators/check-policies.decorator';
import { AppAbility } from '@velero-ui-api/shared/modules/casl/casl-ability.factory';
import { KubeClients } from '@velero-ui-api/shared/modules/kube/kube-clients.service';
import { KubeRegistry } from '@velero-ui-api/shared/modules/kube/kube-registry.service';
import { AppLogger } from '@velero-ui-api/shared/modules/logger/logger.service';

const PROBE_TIMEOUT_MS = 3000;

export class AddClusterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200_000)
  kubeconfig: string;
}

export interface ClusterSummary {
  name: string;
  server: string;
  isDefault: boolean;
  connected: boolean;
  version?: string;
}

/** The clusters (kubeconfig contexts) the UI can switch between. Credentials are never returned. */
@Controller('clusters')
export class ClustersController {
  constructor(
    private readonly registry: KubeRegistry,
    private readonly kube: KubeClients,
    private readonly logger: AppLogger
  ) {}

  @Get()
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Read, Resources.BACKUP.plural))
  public async list(): Promise<{ managed: boolean; clusters: ClusterSummary[] }> {
    const clusters = await Promise.all(this.registry.list().map((c) => this.probe(c)));
    return { managed: this.registry.managed, clusters };
  }

  @Post()
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Manage, 'all'))
  public add(@Body() { kubeconfig }: AddClusterDto): { added: string[] } {
    const added = this.registry.add(kubeconfig);
    this.logger.log(`Added cluster contexts: ${added.join(', ')}`, ClustersController.name);
    return { added };
  }

  @Delete(':name')
  @HttpCode(204)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Manage, 'all'))
  public remove(@Param('name') name: string): void {
    this.registry.remove(name);
    this.logger.log(`Removed cluster context: ${name}`, ClustersController.name);
  }

  private async probe(info: { name: string; server: string; isDefault: boolean }): Promise<ClusterSummary> {
    try {
      const api = this.kube.api(VersionApi, info.name);
      const code = await Promise.race([
        api.getCode(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS).unref()
        ),
      ]);
      return { ...info, connected: true, version: code.gitVersion };
    } catch {
      return { ...info, connected: false };
    }
  }
}
