/* eslint-disable @typescript-eslint/no-explicit-any -- builds a fixture file from untyped API answers */
import 'reflect-metadata';

import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, it } from 'vitest';

import { CaService } from '../src/ca/ca.service';
import { SessionService } from '../src/auth/session.service';
import { newId } from '../src/common/uuid';
import { createTestApp, type TestApp } from './app-harness';
import { World } from './world';

/**
 * Provisions an installation for the load test (docs/LOADTEST.md): one organization, an owner,
 * N clusters with bootstrap tokens, and M members who see every cluster through one team's
 * binding (the shape a real fleet has: bindings per team, not per person). It writes the fixture
 * the Go simulator (`agent/cmd/loadtest`) reads, and it does nothing unless asked:
 *
 *   VFM_LOADTEST_FIXTURE=/tmp/fixture.json LOADTEST_CLUSTERS=200 LOADTEST_USERS=100 \
 *   DATABASE_URL=… REDIS_URL=… VFM_MASTER_KEY=… \
 *   TEST_DATABASE_URL=… TEST_REDIS_URL=… pnpm exec vitest run -c vitest.e2e.config.ts test/loadtest-provision
 *
 * The database and Redis must be the ones the server under test uses, and `VFM_MASTER_KEY` must
 * be the same, or the server cannot read what is written here. Use a throwaway database.
 */
const OUT = process.env.VFM_LOADTEST_FIXTURE;
const CLUSTERS = Number(process.env.LOADTEST_CLUSTERS ?? 200);
const USERS = Number(process.env.LOADTEST_USERS ?? 100);

describe.skipIf(OUT === undefined)('load test fixture', () => {
  let h: TestApp;
  let world: World;

  beforeAll(async () => {
    h = await createTestApp({ gateway: true });
    world = new World(h);
    await world.init();
  }, 120_000);

  afterAll(async () => {
    // Not `h.close()`: that wipes the database and Redis, which is what a test wants and this does not.
    world.close();
    await h.app.close();
  });

  it('writes the fixture', async () => {
    const { call, orgId, userId } = await world.admin();
    const admin = (call as any).cookie as string;
    const adminSession = (call as any).sessionId as string;

    const clusters: { id: string; name: string; bootstrapToken: string }[] = [];
    for (let i = 0; i < CLUSTERS; i += 1) {
      const name = `lt-${String(i + 1).padStart(4, '0')}`;
      const res = await call('post', `/orgs/${orgId}/clusters`, { name }).expect(201);
      clusters.push({ id: res.body.cluster.id, name, bootstrapToken: res.body.bootstrapToken });
    }

    // Members, one team, one cluster-wide read-only binding per cluster for that team.
    const team = (await call('post', `/orgs/${orgId}/teams`, { name: 'viewers' }).expect(201)).body
      .id as string;
    const users: { email: string; cookie: string; csrf: string }[] = [];
    const sessions = h.app.get(SessionService);
    for (let i = 0; i < USERS; i += 1) {
      const id = newId();
      const email = `user-${String(i + 1).padStart(3, '0')}@load.test`;
      await h.prisma.user.create({ data: { id, email, passwordHash: 'x' } as any });
      await h.prisma.inOrg(orgId, async () => {
        await h.prisma.membership.create({
          data: { id: newId(), orgId, userId: id, orgRole: 'MEMBER' } as any,
        });
        await h.prisma.teamMember.create({
          data: { id: newId(), orgId, teamId: team, userId: id } as any,
        });
      });
      const created = await sessions.create({ userId: id, ip: '127.0.0.1', userAgent: 'loadtest' });
      await sessions.update(created.id, { activeOrgId: orgId });
      users.push({
        email,
        cookie: `${SessionService.COOKIE}=${created.id}; ${SessionService.CSRF_COOKIE}=${created.csrfToken}`,
        csrf: created.csrfToken,
      });
    }
    for (const c of clusters) {
      await call('post', `/clusters/${c.id}/role-bindings`, {
        subjectType: 'TEAM',
        subjectId: team,
        role: 'VIEWER',
        scope: { type: 'CLUSTER' },
      }).expect(201);
    }

    const csrf =
      admin
        .split('; ')
        .find((p) => p.startsWith(`${SessionService.CSRF_COOKIE}=`))
        ?.split('=')[1] ?? '';
    writeFileSync(
      OUT as string,
      JSON.stringify(
        {
          apiBase: process.env.LOADTEST_API_BASE ?? 'http://127.0.0.1:3000/api/v1',
          gateway: process.env.LOADTEST_GATEWAY ?? '127.0.0.1:8443',
          gatewayServerName: 'localhost',
          caPem: await h.app.get(CaService).certificatePem(),
          orgId,
          ownerId: userId,
          adminSessionId: adminSession,
          adminCookie: admin,
          adminCsrf: decodeURIComponent(csrf),
          clusters,
          users,
        },
        null,
        2,
      ),
    );
  }, 600_000);
});
