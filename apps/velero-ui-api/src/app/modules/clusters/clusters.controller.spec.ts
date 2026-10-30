import { Test } from '@nestjs/testing';
import { ClustersController } from './clusters.controller';
import { KubeClients } from '@velero-ui-api/shared/modules/kube/kube-clients.service';
import { KubeRegistry } from '@velero-ui-api/shared/modules/kube/kube-registry.service';
import { AppLogger } from '@velero-ui-api/shared/modules/logger/logger.service';

describe('ClustersController', () => {
  const getCode = jest.fn();
  const registry = {
    list: jest.fn(),
    add: jest.fn(),
    remove: jest.fn(),
    managed: true,
  };
  const kube = {
    api: jest.fn((_type: unknown, context?: string) => ({
      getCode: () => getCode(context),
    })),
  };
  const logger = { log: jest.fn() };
  let controller: ClustersController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [ClustersController],
      providers: [
        { provide: KubeRegistry, useValue: registry },
        { provide: KubeClients, useValue: kube },
        { provide: AppLogger, useValue: logger },
      ],
    }).compile();
    controller = module.get(ClustersController);
  });

  it('probes every context with its own name and reports reachability and version', async () => {
    registry.list.mockReturnValue([
      { name: 'up', server: 'https://up', isDefault: true },
      { name: 'down', server: 'https://down', isDefault: false },
    ]);
    getCode.mockImplementation(async (context: string) => {
      if (context === 'down') throw new Error('ECONNREFUSED');
      return { gitVersion: 'v1.30.0' };
    });

    expect(await controller.list()).toEqual({
      managed: true,
      clusters: [
        {
          name: 'up',
          server: 'https://up',
          isDefault: true,
          connected: true,
          version: 'v1.30.0',
        },
        {
          name: 'down',
          server: 'https://down',
          isDefault: false,
          connected: false,
        },
      ],
    });
  });

  it('treats a probe that never answers as unreachable', async () => {
    jest.useFakeTimers();
    registry.list.mockReturnValue([
      { name: 'hang', server: 'https://hang', isDefault: false },
    ]);
    getCode.mockReturnValue(new Promise(() => undefined));

    const pending = controller.list();
    await jest.advanceTimersByTimeAsync(3000);
    expect((await pending).clusters[0].connected).toBe(false);
    jest.useRealTimers();
  });

  it('returns only the names of added contexts, never credentials', () => {
    registry.add.mockReturnValue(['beta']);
    expect(controller.add({ kubeconfig: 'secret: token' })).toEqual({
      added: ['beta'],
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('secret');
  });

  it('removes a context by name', () => {
    controller.remove('beta');
    expect(registry.remove).toHaveBeenCalledWith('beta');
  });
});
