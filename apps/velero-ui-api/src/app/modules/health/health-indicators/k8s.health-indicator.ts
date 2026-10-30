import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { KubeClients } from '@velero-ui-api/shared/modules/kube/kube-clients.service';
import { Health } from '@kubernetes/client-node';
import { from, map, Observable } from 'rxjs';
import https from 'https';

@Injectable()
export class K8sHealthIndicator extends HealthIndicator {
  constructor(private readonly kube: KubeClients) {
    super();
  }

  public isHealthy(): Observable<HealthIndicatorResult> {
    return from(
      new Health(this.kube.config()).readyz({
        agent: new https.Agent({
          rejectUnauthorized: false,
        }),
      }),
    ).pipe(map((alive: boolean) => this.getStatus('k8s', alive)));
  }
}
