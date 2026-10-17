import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RbacService, rbacOptions } from './rbac.service';

function fakePrisma() {
  const calls = { cluster: 0, membership: 0 };
  const prisma = {
    inOrg: <T>(_org: string, fn: () => T) => fn(),
    cluster: {
      findUnique: () => {
        calls.cluster++;
        return Promise.resolve({ id: 'c1' });
      },
    },
    membership: {
      findUnique: () => {
        calls.membership++;
        return Promise.resolve({ orgRole: 'MEMBER' });
      },
    },
    teamMember: { findMany: () => Promise.resolve([]) },
    roleBinding: { findMany: () => Promise.resolve([]) },
    organization: { findUnique: () => Promise.resolve({ settings: {} }) },
  };
  return { prisma, calls };
}

describe('RbacService short-lived cache', () => {
  const before = rbacOptions.cacheMs;
  beforeEach(() => {
    rbacOptions.cacheMs = 2_000;
    vi.useFakeTimers();
  });
  afterEach(() => {
    rbacOptions.cacheMs = before;
    vi.useRealTimers();
  });

  it('reuses one load for concurrent and repeated checks, then expires', async () => {
    const { prisma, calls } = fakePrisma();
    const svc = new RbacService(prisma as never);
    await Promise.all([svc.load('o', 'u', 'c1'), svc.load('o', 'u', 'c1')]);
    await svc.load('o', 'u', 'c1');
    expect(calls.membership).toBe(1);
    vi.advanceTimersByTime(2_001);
    await svc.load('o', 'u', 'c1');
    expect(calls.membership).toBe(2);
  });

  it("applies each caller's token limit on top of the shared facts", async () => {
    const { prisma } = fakePrisma();
    const svc = new RbacService(prisma as never);
    const a = await svc.load('o', 'u', 'c1', { permissions: ['x'], clusterIds: null });
    const b = await svc.load('o', 'u', 'c1');
    expect(a.principal.tokenLimit).toBeDefined();
    expect(b.principal.tokenLimit).toBeUndefined();
  });

  it('caches a cluster that exists, and not at all when disabled', async () => {
    const { prisma, calls } = fakePrisma();
    const svc = new RbacService(prisma as never);
    await svc.assertClusterInOrg('o', 'c1');
    await svc.assertClusterInOrg('o', 'c1');
    expect(calls.cluster).toBe(1);
    rbacOptions.cacheMs = 0;
    await svc.assertClusterInOrg('o', 'c1');
    expect(calls.cluster).toBe(2);
  });
});
