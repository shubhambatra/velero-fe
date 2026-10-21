/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions -- the OpenAPI document and response bodies are walked as untyped data on purpose */
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { newId } from '../src/common/uuid';
import { createTestApp, type TestApp } from './app-harness';
import { World, type Call } from './world';

/**
 * M7 day 37: authorization checked against the contract, not against what someone remembered
 * to test. Every operation in `server/openapi.yaml` is called as
 *
 *  1. nobody,
 *  2. a user of another organization using this organization's ids,
 *  3. the same user using their own org id with this organization's object ids (the classic
 *     insecure direct object reference),
 *  4. a member of the organization who holds no role on any cluster,
 *
 * and none may succeed, fail with a 5xx, or hand back anything that belongs to the victim.
 * A new route is picked up the moment it is in the contract; a new route that is open to
 * someone it should not be fails here without anyone writing a test for it.
 */

interface Operation {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  id: string;
}

const doc = parse(readFileSync(resolve(__dirname, '..', 'openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const operations: Operation[] = Object.entries(doc.paths).flatMap(([path, item]) =>
  METHODS.flatMap((method) =>
    item[method] === undefined
      ? []
      : [{ method, path, id: `${method.toUpperCase()} ${path}` } satisfies Operation],
  ),
);

/** The operations a caller with no credentials may reach, and why (docs/THREAT_MODEL.md §6). */
const PUBLIC: Record<string, string> = {
  'GET /auth/setup': 'first-run bootstrap status',
  'POST /auth/setup': 'first-run bootstrap, gated by a one-time token',
  'POST /auth/login': 'it is the login',
  'GET /healthz': 'orchestrator probe',
  'GET /readyz': 'orchestrator probe',
  'GET /auth/oidc/providers': 'lists enabled sign-in buttons of an org by slug',
  'GET /auth/oidc/{providerId}/start': 'begins a login',
  'GET /auth/oidc/callback': 'finishes a login (state and nonce)',
  'POST /invites/register': 'accepting an emailed invitation (the token is the credential)',
};

/** What a member with no role on any cluster may do in their own org, and why. */
const MEMBER_MAY: Record<string, string> = {
  'GET /orgs/{orgId}': 'org name and slug are for members',
  'GET /orgs/{orgId}/members': 'the member list is for members',
  'GET /orgs/{orgId}/teams': 'team list is for members',
  'GET /orgs/{orgId}/teams/{teamId}/members': 'team membership is for members',
  'GET /orgs/{orgId}/clusters': 'lists only clusters the caller can read: none',
  'GET /orgs/{orgId}/fleet': 'lists only clusters the caller can read: none',
  'GET /orgs/{orgId}/tokens': 'a member lists only their own tokens',
  'POST /orgs/{orgId}/tokens':
    'a member may make a token for themselves (narrowed to what they hold)',
  'DELETE /orgs/{orgId}/tokens/{tokenId}': 'a member revokes only their own (404 for others)',
  'GET /orgs/{orgId}/approvals': 'lists only requests the caller made or may decide',
  'GET /orgs/{orgId}/approvals/count': 'counts only what the caller may decide',
  'GET /orgs/{orgId}/reports/success-rate': 'limited to what the caller may read: nothing',
  'GET /orgs/{orgId}/reports/coverage': 'limited to what the caller may read: nothing',
  'GET /orgs/{orgId}/reports/rpo': 'limited to what the caller may read: nothing',
  'GET /clusters/{clusterId}/my-access': 'says "none" for each permission',
  'GET /orgs/{orgId}/oidc-providers': 'enabled providers of the org (no secrets)',
};

const PLACEHOLDER_NAME = 'x-placeholder';

interface World2 {
  a: {
    orgId: string;
    clusterId: string;
    admin: Call;
    member: Call;
    secrets: string[];
    ids: Record<string, string>;
  };
  b: { orgId: string; clusterId: string; admin: Call };
}

describe('authorization over the whole API contract (e2e)', () => {
  let h: TestApp;
  let world: World;
  let w: World2;
  const log: string[] = [];

  beforeAll(async () => {
    h = await createTestApp();
    world = new World(h);
    await world.init();

    // Organization A: the victim.
    const { call: admin, orgId, userId } = await world.admin();
    const clusterId = (
      await admin('post', `/orgs/${orgId}/clusters`, { name: 'victim-cluster-canary' }).expect(201)
    ).body.cluster.id as string;
    const team = (
      await admin('post', `/orgs/${orgId}/teams`, { name: 'victim-team-canary' }).expect(201)
    ).body.id;
    const channel = (
      await admin('post', `/orgs/${orgId}/channels`, {
        name: 'victim-channel-canary',
        type: 'EMAIL',
        config: { to: ['victim-canary@acme.test'] },
      }).expect(201)
    ).body.id;
    const rule = (
      await admin('post', `/orgs/${orgId}/alerts/rules`, {
        name: 'victim-rule-canary',
        type: 'BSL_UNAVAILABLE',
        channelIds: [channel],
      }).expect(201)
    ).body.id;
    const token = (
      await admin('post', `/orgs/${orgId}/tokens`, { name: 'victim-token-canary' }).expect(201)
    ).body;
    const memberUser = await world.member(admin, orgId, 'plain-member@acme.test');
    const viewer = await world.member(admin, orgId, 'viewer@acme.test');
    const binding = (
      await admin('post', `/clusters/${clusterId}/role-bindings`, {
        subjectType: 'USER',
        subjectId: viewer.userId,
        role: 'VIEWER',
        scope: { type: 'CLUSTER' },
      }).expect(201)
    ).body.id;
    const command = (
      await admin('post', `/orgs/${orgId}/clusters/${clusterId}/refresh-status`).expect(202)
    ).body.id;
    const provider = (
      await admin('post', `/orgs/${orgId}/oidc-providers`, {
        name: 'victim-idp-canary',
        issuer: 'https://idp-canary.example.com',
        clientId: 'c',
        clientSecret: 's',
      }).expect(201)
    ).body.id;
    const invite = (
      await admin('post', `/orgs/${orgId}/invites`, {
        email: 'invitee-canary@acme.test',
        orgRole: 'MEMBER',
      }).expect(201)
    ).body;

    // Organization B: the attacker, an Owner of their own org only.
    const orgB = await h.prisma.organization.create({
      data: { id: newId(), name: 'B', slug: 'b' } as any,
    });
    const userB = await h.prisma.user.create({
      data: { id: newId(), email: 'attacker@b.test', passwordHash: 'x' } as any,
    });
    await h.prisma.inOrg(orgB.id, () =>
      h.prisma.membership.create({
        data: { id: newId(), orgId: orgB.id, userId: userB.id, orgRole: 'OWNER' } as any,
      }),
    );
    const clusterB = await h.prisma.inOrg(orgB.id, () =>
      h.prisma.cluster.create({
        data: { id: newId(), orgId: orgB.id, name: 'attacker-cluster' } as any,
      }),
    );
    const adminB = await world.actAs(userB.id);
    await adminB('post', '/me/active-org', { orgId: orgB.id }).expect(204);

    w = {
      a: {
        orgId,
        clusterId,
        admin,
        member: memberUser.call,
        secrets: [
          'victim-cluster-canary',
          'victim-team-canary',
          'victim-channel-canary',
          'victim-rule-canary',
          'victim-token-canary',
          'victim-idp-canary',
          'victim-canary@acme.test',
          'invitee-canary@acme.test',
          'plain-member@acme.test',
          'idp-canary.example.com',
        ],
        ids: {
          orgId,
          clusterId,
          teamId: team,
          channelId: channel,
          ruleId: rule,
          tokenId: token.id,
          bindingId: binding,
          commandId: command,
          providerId: provider,
          inviteId: invite.id,
          userId,
          sessionId: randomUUID(),
        },
      },
      b: { orgId: orgB.id, clusterId: clusterB.id, admin: adminB },
    };
  }, 120_000);

  afterAll(async () => {
    if (log.length > 0 && process.env.VFM_SECURITY_MATRIX_LOG === '1') {
      console.log(log.join('\n'));
    }
    world.close();
    await h.close();
  });

  const fill = (
    path: string,
    ids: Record<string, string>,
    override: Record<string, string> = {},
  ): string =>
    path.replace(
      /\{(\w+)\}/g,
      (_, name: string) =>
        override[name] ?? ids[name] ?? (name === 'part' ? 'logs' : PLACEHOLDER_NAME),
    );

  /** Sends one request; a stream that stays open counts as a 200. */
  async function send(
    op: Operation,
    path: string,
    as: Call | null,
  ): Promise<{ status: number; text: string }> {
    const body = op.method === 'get' || op.method === 'delete' ? undefined : {};
    const req =
      as === null
        ? (h.api() as any)[op.method](`/api/v1${path}`)
        : (as as any)(op.method, path, body);
    if (as === null && body !== undefined) req.send(body);
    try {
      const res = await req.timeout({ response: 1_500, deadline: 4_000 });
      return { status: res.status, text: res.text ?? JSON.stringify(res.body ?? '') };
    } catch (error: any) {
      if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message))) {
        return { status: 200, text: '(stream)' };
      }
      throw error;
    }
  }

  const scoped = (op: Operation) => op.path.includes('{orgId}') || op.path.includes('{clusterId}');

  it('covers the contract: every operation is known, and the public set is exactly the documented one', () => {
    expect(operations.length).toBeGreaterThanOrEqual(120);
    for (const id of Object.keys(PUBLIC)) {
      expect(
        operations.map((o) => o.id),
        `${id} is documented but not in the contract`,
      ).toContain(id);
    }
  });

  it('refuses a caller with no credentials on every operation except the documented public ones', async () => {
    const open: string[] = [];
    for (const op of operations) {
      const { status } = await send(op, fill(op.path, w.a.ids), null);
      log.push(`anon   ${op.id} -> ${status}`);
      // 502 is an identity provider that cannot be reached (the fixture's issuer does not exist); any other 5xx is a bug.
      expect(status === 502 || status < 500, `${op.id} (anonymous) answered ${status}`).toBe(true);
      if (status !== 401) open.push(`${op.id} -> ${status}`);
    }
    const unexpected = open.filter((o) => !((o.split(' -> ')[0] as string) in PUBLIC));
    expect(
      unexpected,
      'operations that answer an anonymous caller with something other than 401',
    ).toEqual([]);
  }, 180_000);

  /** Path parameters that name a thing belonging to the victim (anything but the org itself). */
  const victimObjects = (op: Operation): string[] =>
    [...op.path.matchAll(/\{(\w+)\}/g)]
      .map((m) => m[1] as string)
      .filter((n) => n !== 'orgId' && n in w.a.ids);

  it('never lets a user of another organization reach this one, by its org id or by its object ids', async () => {
    const failures: string[] = [];
    const check = (op: Operation, kind: string, res: { status: number; text: string }) => {
      log.push(`B/${kind.padEnd(6)} ${op.id} -> ${res.status}`);
      if (res.status >= 500) failures.push(`${op.id} [${kind}] answered ${res.status}`);
      if (res.status >= 200 && res.status < 300)
        failures.push(`${op.id} [${kind}] succeeded (${res.status})`);
      for (const secret of w.a.secrets) {
        if (res.text.includes(secret)) failures.push(`${op.id} [${kind}] leaked "${secret}"`);
      }
    };
    for (const op of operations.filter(scoped)) {
      // (2) Their own session, the victim's org and ids everywhere.
      check(op, 'direct', await send(op, fill(op.path, w.a.ids), w.b.admin));
      // (3) Their own org id with the victim's object ids: an insecure direct object reference.
      // Only meaningful where the path names a victim's object; "my own org" alone is theirs to read.
      if (victimObjects(op).length > 0) {
        check(op, 'idor', await send(op, fill(op.path, w.a.ids, { orgId: w.b.orgId }), w.b.admin));
      }
      // (4) The victim's org with the attacker's own cluster: the cluster is not in that org, and the caller is not in it either.
      if (op.path.includes('{clusterId}') && op.path.includes('{orgId}')) {
        check(
          op,
          'mixed',
          await send(op, fill(op.path, w.a.ids, { clusterId: w.b.clusterId }), w.b.admin),
        );
      }
    }
    // The attacker's own org and cluster must still work, or the tests above prove nothing.
    const control = await send(
      { method: 'get', path: '/orgs/{orgId}/clusters', id: 'GET /orgs/{orgId}/clusters' },
      `/orgs/${w.b.orgId}/clusters`,
      w.b.admin,
    );
    expect(control.status).toBe(200);
    expect(control.text).toContain('attacker-cluster');
    expect(failures).toEqual([]);
  }, 300_000);

  it('gives a member with no role on any cluster nothing that needs one, in their own organization', async () => {
    const failures: string[] = [];
    for (const op of operations.filter(scoped)) {
      const res = await send(op, fill(op.path, w.a.ids), w.a.member);
      log.push(`member ${op.id} -> ${res.status}`);
      if (res.status >= 500) failures.push(`${op.id} answered ${res.status}`);
      if (res.status >= 200 && res.status < 300 && !(op.id in MEMBER_MAY)) {
        failures.push(
          `${op.id} succeeded (${res.status}) for a member with no role and is not on the allowed list`,
        );
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it('keeps every entry of the allowed lists real, so they cannot rot into permission slips', () => {
    const ids = new Set(operations.map((o) => o.id));
    for (const id of [...Object.keys(PUBLIC), ...Object.keys(MEMBER_MAY)]) {
      expect(ids.has(id), `${id} is not an operation of the contract`).toBe(true);
    }
  });
});
