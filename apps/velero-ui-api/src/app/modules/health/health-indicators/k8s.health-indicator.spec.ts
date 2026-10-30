import { Test, TestingModule } from '@nestjs/testing';
import { K8sHealthIndicator } from '@velero-ui-api/modules/health/health-indicators/k8s.health-indicator';
import { KubeClients } from '@velero-ui-api/shared/modules/kube/kube-clients.service';

const readyz = jest.fn();

// The real client is ESM-only, which Jest does not transform.
jest.mock('@kubernetes/client-node', () => ({
  Health: jest.fn().mockImplementation(() => ({ readyz })),
}));

describe('K8sHealthIndicator', () => {
  let service: K8sHealthIndicator;
  const kube = { config: jest.fn().mockReturnValue({}) };

  beforeEach(async () => {
    readyz.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [K8sHealthIndicator, { provide: KubeClients, useValue: kube }],
    }).compile();

    service = module.get<K8sHealthIndicator>(K8sHealthIndicator);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('reports the cluster as up when readyz answers true', (done) => {
    readyz.mockResolvedValue(true);
    service.isHealthy().subscribe((result) => {
      expect(result).toEqual({ k8s: { status: 'up' } });
      done();
    });
  });
});
