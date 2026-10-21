import {
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  Injectable,
  NotFoundException,
  BadGatewayException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { parseOrgSettings } from '../auth/org-mfa-policy';
import { CommandsService } from '../commands/commands.service';
import { coveredBy } from '../inventory/projections';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService, type TokenLimit } from '../rbac/rbac.service';

/** A backup has contents to download once Velero has written them. */
const HAS_CONTENTS = new Set(['Completed', 'PartiallyFailed']);
const WAIT_MS = 45_000;
const POLL_MS = 300;

export interface BackupLink {
  url: string;
  expiresAt: string;
}

/**
 * `backup download` (PLAN.md section 6, P2). Backup data is never proxied: the answer is a short-lived signed
 * link to the object storage, obtained by the agent from Velero's `DownloadRequest(BackupContents)` and
 * handed to this one request.
 *
 * Three independent gates, because this moves customer data out of the cluster: the organization must
 * have turned downloads on (off by default), the caller must hold `backup:download` (Cluster Admin only
 * among the built-in roles) over **every** namespace the backup contains, and the request needs a recent
 * re-authentication and is audited. The link is held in Redis for the waiting request only and is
 * not written to the database, the logs or the audit event.
 */
@Injectable()
export class BackupContentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly commands: CommandsService,
    private readonly audit: AuditService,
  ) {}

  async link(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    request: {
      ip?: string | undefined;
      userAgent?: string | undefined;
      requestId?: string | undefined;
    },
    token?: TokenLimit,
  ): Promise<BackupLink> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    if (!parseOrgSettings(org?.settings).allowBackupContentDownload) {
      this.refused(orgId, userId, clusterId, name, request, 'organization setting is off');
      throw new ForbiddenException(
        'downloading backup contents is turned off for this organization',
      );
    }

    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.veleroResource.findFirst({
        where: { clusterId, kind: 'BACKUP', name, deletedAt: null },
      }),
    );
    const visibility = await this.rbac.visibility(
      orgId,
      userId,
      clusterId,
      'backup:download',
      token,
    );
    // A backup the caller may not wholly download is, for them, not there.
    if (row === null || !(visibility.all || visibility.sees(coveredBy('BACKUP', row.spec)))) {
      throw new NotFoundException('backup not found');
    }
    if (!HAS_CONTENTS.has(row.phase ?? '')) {
      throw new ConflictException(
        `this backup has no contents to download (phase ${row.phase ?? 'unknown'})`,
      );
    }

    const queued = await this.commands.enqueue(
      orgId,
      clusterId,
      userId,
      'GET_BACKUP_DOWNLOAD_URL',
      {
        backupName: name,
      },
    );

    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const link = await this.commands.takeSignedUrl(queued.id);
      if (link !== null) {
        this.audit.record({
          orgId,
          actorType: token === undefined ? 'USER' : 'TOKEN',
          actorId: userId,
          action: 'backup.download-link',
          targetType: 'backup',
          targetId: name,
          clusterId,
          ip: request.ip,
          userAgent: request.userAgent,
          requestId: request.requestId,
          outcome: 'SUCCESS',
          // The link itself is a credential and is not recorded: who asked, for what, until when.
          details: { commandId: queued.id, expiresAt: link.expiresAt },
        });
        return link;
      }
      const current = await this.commands.get(orgId, clusterId, queued.id);
      if (
        current.status === 'FAILED' ||
        current.status === 'TIMED_OUT' ||
        current.status === 'CANCELLED'
      ) {
        if (current.errorCode === 'FORBIDDEN_BY_AGENT_POLICY') {
          throw new ForbiddenException(
            current.errorMessage ?? 'the agent’s policy does not allow this',
          );
        }
        if (current.errorCode === 'NOT_FOUND') {
          throw new NotFoundException('the backup’s contents are not in the object storage');
        }
        throw new BadGatewayException(
          current.errorMessage ?? 'the agent could not obtain a download link',
        );
      }
      if (current.status === 'SUCCEEDED') {
        // Finished with nothing to take: a replayed answer, or someone else took the link first.
        throw new BadGatewayException('the download link is no longer available; ask again');
      }
      if (Date.now() > deadline) {
        throw new GatewayTimeoutException(
          'the agent did not answer in time; is the cluster connected?',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private refused(
    orgId: string,
    userId: string,
    clusterId: string,
    name: string,
    request: {
      ip?: string | undefined;
      userAgent?: string | undefined;
      requestId?: string | undefined;
    },
    why: string,
  ): void {
    this.audit.record({
      orgId,
      actorType: 'USER',
      actorId: userId,
      action: 'backup.download-link',
      targetType: 'backup',
      targetId: name,
      clusterId,
      ip: request.ip,
      userAgent: request.userAgent,
      requestId: request.requestId,
      outcome: 'DENIED',
      details: { reason: why },
    });
  }
}
