import { Injectable } from '@nestjs/common';
import {
  CoreV1Api,
  V1Container,
  V1Pod,
  V1PodList,
  V1PodStatus,
} from '@kubernetes/client-node';
import { catchError, from, map, Observable, tap } from 'rxjs';
import { VELERO } from './velero.constants';
import { ConfigService } from '@nestjs/config';
import { KubeClients } from '@velero-ui-api/shared/modules/kube/kube-clients.service';
import { currentKubeContext } from '@velero-ui-api/shared/modules/kube/kube-context';
import { AppLogger } from '@velero-ui-api/shared/modules/logger/logger.service';

@Injectable()
export class VeleroService {
  // Pod names are per cluster context, so switching clusters never reuses another cluster's pod.
  private readonly serverPods = new Map<string, string>();
  private readonly uiPods = new Map<string, string>();

  constructor(
    private readonly kube: KubeClients,
    private logger: AppLogger,
    private configService: ConfigService
  ) {
    this.findServer().subscribe({ error: () => undefined });
  }

  private get k8sCoreV1Api(): CoreV1Api {
    return this.kube.api(CoreV1Api);
  }

  private get podServerName(): string {
    return this.serverPods.get(currentKubeContext() ?? '');
  }

  private set podServerName(name: string) {
    this.serverPods.set(currentKubeContext() ?? '', name);
  }

  private get podVeleroUIName(): string {
    return this.uiPods.get(currentKubeContext() ?? '');
  }

  private set podVeleroUIName(name: string) {
    this.uiPods.set(currentKubeContext() ?? '', name);
  }

  public checkServer(): Observable<string> {
    return this.getServerStatus()
      .pipe(catchError(() => this.findServer()))
      .pipe(map(() => this.podServerName));
  }

  public checkVeleroUI(): Observable<string> {
    return this.getVeleroUIStatus()
      .pipe(catchError(() => this.findVeleroUI()))
      .pipe(map(() => this.podVeleroUIName));
  }

  public getServerStatus(): Observable<V1PodStatus> {
    return from(
      this.k8sCoreV1Api.readNamespacedPodStatus({
        name: this.podServerName,
        namespace: this.configService.get('velero.namespace'),
      })
    ).pipe(map((r: V1Pod) => r.status));
  }

  public getVeleroUIStatus(): Observable<V1PodStatus> {
    return from(
      this.k8sCoreV1Api.readNamespacedPodStatus({
        name: this.podVeleroUIName,
        namespace: this.configService.get('app.namespace'),
      })
    ).pipe(map((r: V1Pod) => r.status));
  }

  public getVeleroUI(): Observable<V1Pod> {
    return from(
      this.k8sCoreV1Api.readNamespacedPod({
        name: this.podVeleroUIName,
        namespace: this.configService.get('app.namespace'),
      })
    );
  }

  public getServer(): Observable<V1Pod> {
    return from(
      this.k8sCoreV1Api.readNamespacedPod({
        name: this.podServerName,
        namespace: this.configService.get('velero.namespace'),
      })
    );
  }

  public getAgents(): Observable<V1Pod[]> {
    this.logger.debug(`Finding Velero agent pods...`, VeleroService.name);
    return from(
      this.k8sCoreV1Api.listNamespacedPod({
        namespace: this.configService.get('velero.namespace'),
      })
    )
      .pipe(map((r: V1PodList) => r.items))
      .pipe(
        map((pods: V1Pod[]) =>
          pods.filter((pod: V1Pod) =>
            pod.spec?.containers?.find(
              (container: V1Container) =>
                container.name === VELERO.AGENT_CONTAINER_NAME
            )
          )
        ),
        tap((pods: V1Pod[]) =>
          this.logger.debug(
            `Found ${pods.length} Velero agent pods.`,
            VeleroService.name
          )
        )
      );
  }

  private findServer(): Observable<V1Pod> {
    this.logger.debug(`Finding Velero server pod...`, VeleroService.name);
    return from(
      this.k8sCoreV1Api.listNamespacedPod({
        namespace: this.configService.get('velero.namespace'),
      })
    )
      .pipe(map((r: V1PodList) => r.items))
      .pipe(
        map(
          (pods: V1Pod[]): V1Pod =>
            pods.find((pod: V1Pod) =>
              pod.spec?.containers?.find(
                (container: V1Container) =>
                  container.name === VELERO.SERVER_CONTAINER_NAME
              )
            )
        )
      )
      .pipe(
        tap((pod: V1Pod): void => {
          if (pod) {
            this.logger.debug(
              `Found Velero server pod: ${pod.metadata.name}.`,
              VeleroService.name
            );
            this.podServerName = pod.metadata.name;
          } else {
            throw new Error('Cannot find Velero server!');
          }
        })
      );
  }

  private findVeleroUI(): Observable<V1Pod> {
    this.logger.debug(`Finding Velero UI pod...`, VeleroService.name);
    return from(
      this.k8sCoreV1Api.listNamespacedPod({
        namespace: this.configService.get('app.namespace'),
      })
    )
      .pipe(map((r: V1PodList) => r.items))
      .pipe(
        map(
          (pods: V1Pod[]): V1Pod =>
            pods.find((pod: V1Pod) =>
              pod.spec?.containers?.find(
                (container: V1Container) =>
                  container.name === VELERO.UI_CONTAINER_NAME
              )
            )
        )
      )
      .pipe(
        tap((pod: V1Pod): void => {
          if (pod) {
            this.logger.debug(
              `Found Velero UI pod: ${pod.metadata.name}.`,
              VeleroService.name
            );
            this.podVeleroUIName = pod.metadata.name;
          } else {
            throw new Error('Cannot find Velero UI!');
          }
        })
      );
  }
}
