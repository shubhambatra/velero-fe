import { Injectable } from '@nestjs/common';
import { KubeClients } from '@velero-ui-api/shared/modules/kube/kube-clients.service';
import {
  CustomObjectsApi,
  KubernetesObject,
} from '@kubernetes/client-node';
import {
  Resources,
  V1DownloadRequest,
  V1DownloadRequestPhase,
} from '@velero-ui/velero';
import { ConfigService } from '@nestjs/config';
import {
  catchError,
  concatMap,
  defer,
  from,
  map,
  Observable,
  of,
  retry,
  throwError,
} from 'rxjs';
import { CreateDownloadRequestDto } from '@velero-ui-api/shared/dto/download-request.dto';
import { VELERO } from '@velero-ui-api/shared/modules/velero/velero.constants';
import { createK8sCustomObject } from '@velero-ui-api/modules/k8s-custom-object/k8s-custom-object.utils';
import { K8sCustomObjectService } from '@velero-ui-api/modules/k8s-custom-object/k8s-custom-object.service';

@Injectable()
export class DownloadRequestService {
  private get k8sCustomObjectApi(): CustomObjectsApi {
    return this.kube.api(CustomObjectsApi);
  }

  constructor(
    private readonly kube: KubeClients,
    private readonly k8sCustomObjectService: K8sCustomObjectService,
    private readonly configService: ConfigService
  ) {
  }

  public create(body: CreateDownloadRequestDto): Observable<V1DownloadRequest> {
    return of(
      createK8sCustomObject(
        body.name,
        this.configService.get('velero.namespace'),
        Resources.DOWNLOAD_REQUEST,
        {},
        {
          target: body,
        }
      )
    )
      .pipe(
        concatMap((body: KubernetesObject) =>
          this.k8sCustomObjectService.create(
            Resources.DOWNLOAD_REQUEST.plural,
            body
          )
        )
      )
      .pipe(
        concatMap((request: V1DownloadRequest) =>
          this.waitAndGetDownloadRequest(request)
        )
      );
  }

  private waitAndGetDownloadRequest(
    request: V1DownloadRequest
  ): Observable<V1DownloadRequest> {
    return defer(() =>
      from(
        this.k8sCustomObjectApi.getNamespacedCustomObject({
          group: VELERO.GROUP,
          version: VELERO.VERSION,
          namespace: this.configService.get('velero.namespace'),
          plural: Resources.DOWNLOAD_REQUEST.plural,
          name: request.metadata.name,
        })
      )
    ).pipe(
      map((requestStatus: V1DownloadRequest): V1DownloadRequest => {
        if (requestStatus?.status?.phase !== V1DownloadRequestPhase.Processed) {
          throw new Error('Download request is not ready!');
        }
        return requestStatus;
      }),
      retry({
        count: 5,
        delay: 4000,
      }),
      catchError(() => {
        return throwError(
          () => new Error('Download request is not ready after 5 retries!')
        );
      })
    );
  }
}
