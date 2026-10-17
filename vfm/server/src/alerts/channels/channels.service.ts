import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { newId } from '../../common/uuid';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { CryptoService, EncryptionContext } from '../../crypto/crypto.service';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CHANNEL_TYPES,
  checkInput,
  newSecret,
  readConfig,
  viewOf,
  type ChannelConfig,
  type ChannelType,
  type ChannelView,
} from './channel-config';
import { EgressError, postJson, type EgressPolicy } from './egress';
import {
  emailText,
  slackBody,
  subject,
  webhookBody,
  webhookHeaders,
  type MessageInput,
} from './messages';

export const createChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(CHANNEL_TYPES),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export const updateChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    /** Webhook only: make a new signing secret (shown once, in the answer). */
    rotateSecret: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

const MAX_CHANNELS_PER_ORG = 50;

export interface ChannelSummary {
  id: string;
  name: string;
  type: ChannelType;
  createdAt: Date;
  updatedAt: Date;
  config: ChannelView;
}

type Row = {
  id: string;
  name: string;
  type: ChannelType;
  configEncrypted: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ChannelsService {
  readonly policy: EgressPolicy;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.policy = {
      allowPrivate: env.ALERT_WEBHOOK_ALLOW_PRIVATE,
      allowHttp: env.ALERT_WEBHOOK_ALLOW_HTTP,
    };
  }

  async list(orgId: string): Promise<ChannelSummary[]> {
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.notificationChannel.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } }),
    );
    return rows.map((r) => this.summary(r as Row));
  }

  async create(
    orgId: string,
    body: z.infer<typeof createChannelSchema>,
  ): Promise<ChannelSummary & { secret?: string }> {
    const checked = checkInput(body.type, body.config, this.policy);
    if (!checked.ok) throw new BadRequestException(checked.message);
    const id = newId();
    const config: ChannelConfig =
      body.type === 'EMAIL'
        ? { type: 'EMAIL', to: checked.value.to ?? [] }
        : body.type === 'WEBHOOK'
          ? { type: 'WEBHOOK', url: checked.value.url ?? '', secret: newSecret() }
          : { type: 'SLACK_WEBHOOK', url: checked.value.url ?? '' };
    const row = await this.prisma.inOrg(orgId, async () => {
      if (
        (await this.prisma.notificationChannel.count({ where: { orgId } })) >= MAX_CHANNELS_PER_ORG
      ) {
        throw new BadRequestException(
          `an organization may have at most ${MAX_CHANNELS_PER_ORG.toString()} channels`,
        );
      }
      try {
        return await this.prisma.notificationChannel.create({
          data: {
            id,
            orgId,
            name: body.name,
            type: body.type,
            configEncrypted: this.seal(id, config),
          },
        });
      } catch (error: unknown) {
        throw this.conflict(error);
      }
    });
    return {
      ...this.summary(row),
      ...(config.type === 'WEBHOOK' ? { secret: config.secret } : {}),
    };
  }

  async update(
    orgId: string,
    channelId: string,
    body: z.infer<typeof updateChannelSchema>,
  ): Promise<ChannelSummary & { secret?: string }> {
    const existing = await this.row(orgId, channelId);
    const current = this.open(existing);
    let next: ChannelConfig = current;
    if (body.config !== undefined) {
      const checked = checkInput(existing.type, body.config, this.policy);
      if (!checked.ok) throw new BadRequestException(checked.message);
      next =
        current.type === 'EMAIL'
          ? { type: 'EMAIL', to: checked.value.to ?? current.to }
          : current.type === 'WEBHOOK'
            ? { ...current, url: checked.value.url ?? current.url }
            : { type: 'SLACK_WEBHOOK', url: checked.value.url ?? current.url };
    }
    let secret: string | undefined;
    if (body.rotateSecret === true) {
      if (next.type !== 'WEBHOOK')
        throw new BadRequestException('only a webhook channel has a signing secret');
      secret = newSecret();
      next = { ...next, secret };
    }
    const row = await this.prisma.inOrg(orgId, async () => {
      try {
        return await this.prisma.notificationChannel.update({
          where: { id: channelId },
          data: {
            ...(body.name === undefined ? {} : { name: body.name }),
            configEncrypted: this.seal(channelId, next),
          },
        });
      } catch (error: unknown) {
        throw this.conflict(error);
      }
    });
    return { ...this.summary(row), ...(secret === undefined ? {} : { secret }) };
  }

  /** Deletes the channel and takes its id out of every rule that named it. */
  async remove(orgId: string, channelId: string): Promise<void> {
    await this.row(orgId, channelId);
    await this.prisma.inOrg(orgId, async () => {
      const rules = await this.prisma.alertRule.findMany({ where: { orgId } });
      for (const rule of rules) {
        const ids = Array.isArray(rule.channelIds) ? rule.channelIds : [];
        if (ids.includes(channelId)) {
          await this.prisma.alertRule.update({
            where: { id: rule.id },
            data: { channelIds: ids.filter((c) => c !== channelId) },
          });
        }
      }
      await this.prisma.notificationChannel.deleteMany({ where: { id: channelId, orgId } });
    });
  }

  /** Channels by id, for delivery. Ids that no longer exist are simply absent. */
  async load(
    orgId: string,
    ids: string[],
  ): Promise<{ id: string; name: string; config: ChannelConfig }[]> {
    const rows = await this.prisma.inOrg(orgId, () =>
      this.prisma.notificationChannel.findMany({ where: { orgId, id: { in: ids } } }),
    );
    return rows.flatMap((r) => {
      try {
        return [{ id: r.id, name: r.name, config: this.open(r) }];
      } catch {
        // A channel that cannot be opened (a retired key, a damaged value) is a failed delivery, not a crash.
        return [{ id: r.id, name: r.name, config: { type: 'EMAIL' as const, to: [] } }];
      }
    });
  }

  /** Checks that every id names a channel of this org. */
  async assertAll(orgId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.prisma.inOrg(orgId, () =>
      this.prisma.notificationChannel.count({ where: { orgId, id: { in: ids } } }),
    );
    if (found !== new Set(ids).size) {
      throw new BadRequestException('channelIds names a channel that is not in this organization');
    }
  }

  /** Sends one message to one channel. Throws a fixed-sentence error when it cannot. */
  async send(config: ChannelConfig, message: MessageInput, now: Date = new Date()): Promise<void> {
    if (config.type === 'EMAIL') {
      if (config.to.length === 0) throw new EgressError('the channel has no recipients', false);
      if (!this.mail.configured)
        throw new EgressError('email delivery is not configured on this server', false);
      let failed = 0;
      for (const to of config.to) {
        try {
          await this.mail.send({ to, subject: subject(message), text: emailText(message) });
        } catch {
          failed += 1;
        }
      }
      if (failed === config.to.length)
        throw new EgressError('the mail server refused every recipient', true);
      return;
    }
    if (config.type === 'WEBHOOK') {
      const body = webhookBody(message);
      await postJson(
        config.url,
        webhookHeaders(config.secret, message, body, now),
        body,
        this.policy,
      );
      return;
    }
    await postJson(config.url, {}, slackBody(message), this.policy);
  }

  /** The "send a test" button: one attempt, and the answer says what happened. */
  async test(orgId: string, channelId: string): Promise<{ ok: boolean; error?: string }> {
    const row = await this.row(orgId, channelId);
    const now = new Date();
    try {
      await this.send(
        this.open(row),
        {
          kind: 'test',
          orgId,
          rule: { id: newId(), name: 'Test message', type: 'TEST' },
          cluster: { id: newId(), name: 'example-cluster' },
          event: { id: newId(), fingerprint: 'test', payload: {}, firedAt: now, resolvedAt: null },
          link: `${this.env.PUBLIC_URL}/alerts`,
        },
        now,
      );
      return { ok: true };
    } catch (error: unknown) {
      return {
        ok: false,
        error: error instanceof EgressError ? error.message : 'the channel could not be used',
      };
    }
  }

  private async row(orgId: string, id: string): Promise<Row> {
    const row = await this.prisma.inOrg(orgId, () =>
      this.prisma.notificationChannel.findFirst({ where: { id, orgId } }),
    );
    if (row === null) throw new NotFoundException('channel not found');
    return row;
  }

  private seal(id: string, config: ChannelConfig): string {
    const { type: _type, ...rest } = config;
    return this.crypto.encrypt(
      JSON.stringify(rest),
      EncryptionContext.notificationChannelConfig(id),
    );
  }

  private open(row: Row): ChannelConfig {
    const json = this.crypto.decrypt(
      row.configEncrypted,
      EncryptionContext.notificationChannelConfig(row.id),
    );
    const config = readConfig(row.type, json);
    if (config === null) throw new Error('stored channel configuration is not readable');
    return config;
  }

  private summary(row: Row): ChannelSummary {
    let view: ChannelView = {};
    try {
      view = viewOf(this.open(row));
    } catch {
      // Shown as a channel with nothing to show; sending to it fails with a clear error.
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      config: view,
    };
  }

  private conflict(error: unknown): unknown {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
      ? new ConflictException('a channel with this name already exists')
      : error;
  }
}
