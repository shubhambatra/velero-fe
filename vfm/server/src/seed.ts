/**
 * Seeds a DEVELOPMENT installation (PLAN.md section 14.1): a platform administrator, two organizations, a user for
 * each built-in role, and one cluster per organization with a fresh bootstrap token.
 *
 *   pnpm --filter @vfm/server run build && pnpm --filter @vfm/server run seed   # prints JSON: users, and each cluster's id and token
 *
 * It runs from the build (`node dist/seed.js`), not from source: Nest's dependency injection needs the decorator
 * metadata that `tsx` does not emit.
 *
 * It uses the server's own services, so passwords are hashed and bindings validated exactly as in the product,
 * and it is safe to run again: whatever exists is left alone (a cluster that exists gets a new token only if it
 * has never been enrolled). It refuses to run when NODE_ENV=production.
 *
 * Every account shares one password, from SEED_PASSWORD (default below). That is the point of a seed and
 * the reason it must never touch a real installation.
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { ClusterRole } from '@vfm/shared';

import { AppModule } from './app.module';
import { PasswordService } from './auth/password.service';
import { CaService } from './ca/ca.service';
import { newId } from './common/uuid';
import { ClustersService } from './clusters/clusters.service';
import { OrgsService } from './orgs/orgs.service';
import { PrismaService } from './prisma/prisma.service';
import { RoleBindingsService } from './rbac/role-bindings.service';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Velero-dev-Seed-9';
const ORGS = [
  { name: 'Acme', slug: 'acme', cluster: 'vfm-a' },
  { name: 'Globex', slug: 'globex', cluster: 'vfm-b' },
] as const;

/** Org-level roles, and the cluster roles (whole cluster) the built-in matrix defines, one user each. */
const ORG_USERS: {
  local: string;
  orgRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  cluster?: ClusterRole;
  namespaces?: string[];
}[] = [
  { local: 'owner', orgRole: 'OWNER' },
  { local: 'admin', orgRole: 'ADMIN' },
  { local: 'member', orgRole: 'MEMBER' },
  { local: 'viewer', orgRole: 'MEMBER', cluster: 'VIEWER' },
  { local: 'operator', orgRole: 'MEMBER', cluster: 'OPERATOR' },
  { local: 'restorer', orgRole: 'MEMBER', cluster: 'RESTORER' },
  { local: 'clusteradmin', orgRole: 'MEMBER', cluster: 'CLUSTER_ADMIN' },
  // One restricted to a single namespace, to see namespace scoping working.
  { local: 'scoped-operator', orgRole: 'MEMBER', cluster: 'OPERATOR', namespaces: ['demo'] },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'the seed creates accounts with a shared password; it will not run in production',
    );
  }
  // No listeners, timers or gateway: this only writes rows.
  process.env.GATEWAY_ENABLED = 'false';
  process.env.RETENTION_INTERVAL_HOURS = '0';
  process.env.ALERT_EVAL_INTERVAL_SECONDS = '0';

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);
    const passwords = app.get(PasswordService);
    const orgs = app.get(OrgsService);
    const clusters = app.get(ClustersService);
    const bindings = app.get(RoleBindingsService, { strict: false });
    const hash = await passwords.hash(PASSWORD);

    const user = async (email: string, platformAdmin = false): Promise<string> => {
      const found = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (found !== null) return found.id;
      const id = newId();
      await prisma.user.create({
        data: {
          id,
          email,
          name: email.split('@')[0] ?? null,
          passwordHash: hash,
          isPlatformAdmin: platformAdmin,
        },
      });
      return id;
    };

    const admin = await user('admin@vfm.local', true);
    const out: {
      caPem: string;
      password: string;
      users: string[];
      clusters: { org: string; name: string; id: string; bootstrapToken: string | null }[];
    } = {
      caPem: await app.get(CaService, { strict: false }).certificatePem(),
      password: PASSWORD,
      users: ['admin@vfm.local (platform admin)'],
      clusters: [],
    };

    for (const o of ORGS) {
      let org = await prisma.organization.findUnique({
        where: { slug: o.slug },
        select: { id: true },
      });
      org ??= await orgs.create(admin, { name: o.name, slug: o.slug });

      const existing = await prisma.unscoped('the seed spans organizations', () =>
        prisma.cluster.findFirst({
          where: { orgId: org.id, name: o.cluster },
          select: { id: true, status: true },
        }),
      );
      let clusterId = existing?.id;
      let token: string | null = null;
      if (existing === null) {
        const made = await clusters.create(org.id, { name: o.cluster });
        clusterId = made.cluster.id;
        token = made.bootstrapToken;
      }
      out.clusters.push({
        org: o.slug,
        name: o.cluster,
        id: clusterId ?? '',
        bootstrapToken: token,
      });

      for (const u of ORG_USERS) {
        const email = `${u.local}@${o.slug}.dev`;
        const id = await user(email);
        out.users.push(
          `${email} (${u.orgRole}${u.cluster ? `, ${u.cluster}${u.namespaces ? ` in ${u.namespaces.join(',')}` : ''}` : ''})`,
        );
        await prisma.inOrg(org.id, () =>
          prisma.membership.upsert({
            where: { orgId_userId: { orgId: org.id, userId: id } },
            create: { id: newId(), orgId: org.id, userId: id, orgRole: u.orgRole },
            update: {},
          }),
        );
        if (u.cluster !== undefined && clusterId !== undefined) {
          const has = await prisma.inOrg(org.id, () =>
            prisma.roleBinding.count({ where: { clusterId, subjectId: id } }),
          );
          if (has === 0) {
            await bindings.create(org.id, clusterId, admin, {
              subjectType: 'USER',
              subjectId: id,
              role: u.cluster,
              scope: u.namespaces
                ? { type: 'NAMESPACES', namespaces: u.namespaces }
                : { type: 'CLUSTER' },
            });
          }
        }
      }
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
