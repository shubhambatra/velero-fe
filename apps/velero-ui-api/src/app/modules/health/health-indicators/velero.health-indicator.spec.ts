import { Test, TestingModule } from '@nestjs/testing';
import { VeleroHealthIndicator } from '@velero-ui-api/modules/health/health-indicators/velero.health-indicator';
import { VeleroService } from '@velero-ui-api/shared/modules/velero/velero.service';
import { of } from 'rxjs';

// VeleroService pulls in the ESM-only Kubernetes client, which Jest does not transform.
jest.mock('@kubernetes/client-node', () => ({ CoreV1Api: class {} }));

describe('VeleroHealthIndicator', () => {
  let service: VeleroHealthIndicator;
  const velero = { getServerStatus: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VeleroHealthIndicator, { provide: VeleroService, useValue: velero }],
    }).compile();

    service = module.get<VeleroHealthIndicator>(VeleroHealthIndicator);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('is up only while the Velero server pod is Running', (done) => {
    velero.getServerStatus.mockReturnValue(of({ phase: 'Running' }));
    service.isHealthy().subscribe((result) => {
      expect(result.velero.status).toBe('up');
      done();
    });
  });

  it('is down for any other phase', (done) => {
    velero.getServerStatus.mockReturnValue(of({ phase: 'Pending' }));
    service.isHealthy().subscribe((result) => {
      expect(result.velero.status).toBe('down');
      done();
    });
  });
});
