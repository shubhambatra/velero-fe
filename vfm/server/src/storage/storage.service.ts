import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { CommandsService, type CommandView } from '../commands/commands.service';
import { parseBody } from '../common/parse-body';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService, type TokenLimit } from '../rbac/rbac.service';
import {
  checkLocation,
  createBackupLocationBody,
  createSnapshotLocationBody,
  splitCredential,
  updateBackupLocationBody,
  updateSnapshotLocationBody,
  type LocationPayload,
} from './location-request';

type LocationKind = 'BACKUP_STORAGE_LOCATION' | 'VOLUME_SNAPSHOT_LOCATION';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Storage location operations: create, change, make default, delete (PLAN.md §6, §16 day 26).
 *
 * Locations are cluster-level, so every one of these needs `storage:write` over the whole
 * cluster; a user limited to some namespaces is refused. A credential in a request goes to
 * the agent and nowhere else (see `location-request.ts`): the command row and the audit
 * entry never hold it.
 */
@Injectable()
export class StorageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly commands: CommandsService,
  ) {}

  async createBackupLocation(
    orgId: string,
    userId: string,
    clusterId: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(createBackupLocationBody, rawBody);
    await this.authorize(orgId, userId, clusterId, token);
    this.check(body);
    await this.mustNotExist(orgId, clusterId, 'BACKUP_STORAGE_LOCATION', body.name);
    const { name, credential: _credential, ...spec } = body;
    const split = splitCredential('vfm-bsl', name, body);
    return this.commands.enqueue(
      orgId,
      clusterId,
      userId,
      'UPSERT_BSL',
      payload(name, spec, split),
      split.transient,
    );
  }

  async updateBackupLocation(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(updateBackupLocationBody, rawBody);
    await this.authorize(orgId, userId, clusterId, token);
    this.check(body);
    const row = await this.mustExist(orgId, clusterId, 'BACKUP_STORAGE_LOCATION', name);
    const { credential: _credential, ...spec } = body;
    // Replacing the spec must not silently demote the default location.
    const current = isRecord(row.spec) ? row.spec : {};
    spec.default = body.default ?? current.default === true;
    const split = splitCredential('vfm-bsl', name, body, referenceOf(current));
    return this.commands.enqueue(
      orgId,
      clusterId,
      userId,
      'UPSERT_BSL',
      payload(row.name, spec, split),
      split.transient,
    );
  }

  async setDefault(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    token?: TokenLimit,
  ): Promise<CommandView> {
    await this.authorize(orgId, userId, clusterId, token);
    const row = await this.mustExist(orgId, clusterId, 'BACKUP_STORAGE_LOCATION', name);
    return this.commands.enqueue(orgId, clusterId, userId, 'SET_DEFAULT_BSL', { name: row.name });
  }

  async deleteBackupLocation(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    token?: TokenLimit,
  ): Promise<CommandView> {
    await this.authorize(orgId, userId, clusterId, token);
    const row = await this.mustExist(orgId, clusterId, 'BACKUP_STORAGE_LOCATION', name);
    const others = await this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.count({
        where: { clusterId, kind: 'BACKUP_STORAGE_LOCATION', deletedAt: null, NOT: { name } },
      }),
    );
    if (isRecord(row.spec) && row.spec.default === true && others > 0) {
      throw new ConflictException(
        'this is the default location; make another one the default before deleting it',
      );
    }
    return this.commands.enqueue(orgId, clusterId, userId, 'DELETE_BSL', { name: row.name });
  }

  async createSnapshotLocation(
    orgId: string,
    userId: string,
    clusterId: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(createSnapshotLocationBody, rawBody);
    await this.authorize(orgId, userId, clusterId, token);
    this.check(body);
    await this.mustNotExist(orgId, clusterId, 'VOLUME_SNAPSHOT_LOCATION', body.name);
    const { name, credential: _credential, ...spec } = body;
    const split = splitCredential('vfm-vsl', name, body);
    return this.commands.enqueue(
      orgId,
      clusterId,
      userId,
      'UPSERT_VSL',
      payload(name, spec, split),
      split.transient,
    );
  }

  async updateSnapshotLocation(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    rawBody: unknown,
    token?: TokenLimit,
  ): Promise<CommandView> {
    const body = parseBody(updateSnapshotLocationBody, rawBody);
    await this.authorize(orgId, userId, clusterId, token);
    this.check(body);
    const row = await this.mustExist(orgId, clusterId, 'VOLUME_SNAPSHOT_LOCATION', name);
    const { credential: _credential, ...spec } = body;
    const split = splitCredential(
      'vfm-vsl',
      name,
      body,
      referenceOf(isRecord(row.spec) ? row.spec : {}),
    );
    return this.commands.enqueue(
      orgId,
      clusterId,
      userId,
      'UPSERT_VSL',
      payload(row.name, spec, split),
      split.transient,
    );
  }

  async deleteSnapshotLocation(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    token?: TokenLimit,
  ): Promise<CommandView> {
    await this.authorize(orgId, userId, clusterId, token);
    const row = await this.mustExist(orgId, clusterId, 'VOLUME_SNAPSHOT_LOCATION', name);
    return this.commands.enqueue(orgId, clusterId, userId, 'DELETE_VSL', { name: row.name });
  }

  private check(body: Parameters<typeof checkLocation>[0]): void {
    const problem = checkLocation(body);
    if (problem !== undefined) {
      throw new UnprocessableEntityException(problem);
    }
  }

  private async authorize(
    orgId: string,
    userId: string,
    clusterId: string,
    token?: TokenLimit,
  ): Promise<void> {
    await this.rbac.require(
      orgId,
      userId,
      { clusterId, permission: 'storage:write', namespaces: [] },
      token,
    );
  }

  private find(orgId: string, clusterId: string, kind: LocationKind, name: string) {
    return this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.findFirst({
        where: { clusterId, kind, name, deletedAt: null },
      }),
    );
  }

  private async mustExist(orgId: string, clusterId: string, kind: LocationKind, name: string) {
    const row = await this.find(orgId, clusterId, kind, name);
    if (row === null) {
      throw new NotFoundException('location not found');
    }
    return row;
  }

  private async mustNotExist(
    orgId: string,
    clusterId: string,
    kind: LocationKind,
    name: string,
  ): Promise<void> {
    if ((await this.find(orgId, clusterId, kind, name)) !== null) {
      throw new ConflictException('a location with this name already exists');
    }
  }
}

/** The Secret an existing location points at, from its stored spec. */
function referenceOf(spec: Record<string, unknown>): { name: string; key: string } | undefined {
  const ref = spec.credential;
  return isRecord(ref) && typeof ref.name === 'string' && typeof ref.key === 'string'
    ? { name: ref.name, key: ref.key }
    : undefined;
}

function payload(
  name: string,
  spec: object,
  split: ReturnType<typeof splitCredential>,
): LocationPayload {
  return {
    name,
    spec: { ...spec },
    ...(split.secretRef === undefined ? {} : { secretRef: split.secretRef }),
    ...(split.rotatesSecret === true ? { rotatesSecret: true } : {}),
  };
}
