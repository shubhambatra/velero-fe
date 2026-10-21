import { Injectable, Logger } from '@nestjs/common';

import { Inject } from '@nestjs/common';

import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { newId } from '../../common/uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertNotifier, type AlertNotification } from '../notifier';
import { EgressError } from './egress';
import { ChannelsService } from './channels.service';
import { alertDeliveries } from '../../metrics/metrics';

/** Tunable so tests need not wait; production values are the defaults. */
export const deliveryOptions = {
  attempts: 3,
  backoffMs: [500, 2000],
  /** After every channel failed, wait this long before trying the same message again. */
  retryAfterMs: 5 * 60_000,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Takes an alert notification to the channels its rule names (PLAN.md §16 day 33).
 *
 * Each channel is tried up to three times for the kinds of failure that pass (a timeout, a 5xx,
 * a 429) and once for the kinds that do not (a refused address, a 4xx, a bad certificate). Every
 * attempt's outcome is a row in `alert_deliveries`, so a channel that is down shows up in the
 * history instead of vanishing.
 *
 * It returns when at least one channel took the message, and throws only when every one failed,
 * so the engine offers the message again — but no sooner than `retryAfterMs` after the last
 * failure, so a dead channel is not hammered every evaluation. A channel that failed while
 * another succeeded is not retried for this message: that would send the others a duplicate.
 */
@Injectable()
export class ChannelNotifier extends AlertNotifier {
  private readonly logger = new Logger('Alerts');

  constructor(
    private readonly channels: ChannelsService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {
    super();
  }

  async notify(n: AlertNotification): Promise<void> {
    const recent = await this.prisma.inOrg(n.orgId, () =>
      this.prisma.alertDelivery.findMany({
        where: { orgId: n.orgId, eventId: n.event.id, kind: n.kind },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { ok: true, createdAt: true },
      }),
    );
    const last = recent[0];
    if (
      last !== undefined &&
      recent.every((d) => !d.ok) &&
      Date.now() - last.createdAt.getTime() < deliveryOptions.retryAfterMs
    ) {
      throw new Error('every channel failed recently; waiting before trying again');
    }

    const channels = await this.channels.load(n.orgId, n.channelIds);
    if (channels.length === 0) {
      // Every channel the rule named has been deleted: nothing can be told, and nothing will be.
      return;
    }
    const cluster =
      typeof n.event.payload.cluster === 'string' ? n.event.payload.cluster : n.event.clusterId;
    const message = {
      kind: n.kind,
      orgId: n.orgId,
      rule: n.rule,
      cluster: { id: n.event.clusterId, name: cluster },
      event: n.event,
      link: `${this.env.PUBLIC_URL}/alerts`,
    };

    let delivered = 0;
    for (const channel of channels) {
      const error = await this.attempt(channel.config, message);
      await this.prisma.inOrg(n.orgId, () =>
        this.prisma.alertDelivery.create({
          data: {
            id: newId(),
            orgId: n.orgId,
            eventId: n.event.id,
            channelId: channel.id,
            channelName: channel.name,
            kind: n.kind,
            ok: error === null,
            error,
          },
        }),
      );
      alertDeliveries.inc({ kind: n.kind, ok: error === null ? 'true' : 'false' });
      if (error === null) delivered += 1;
      else this.logger.warn(`alert ${n.kind} to channel "${channel.name}" failed: ${error}`);
    }
    if (delivered === 0) {
      throw new Error('no channel accepted the notification');
    }
  }

  /** Null when it was sent, else the fixed sentence saying why not. */
  private async attempt(
    config: Parameters<ChannelsService['send']>[0],
    message: Parameters<ChannelsService['send']>[1],
  ): Promise<string | null> {
    for (let i = 0; ; i += 1) {
      try {
        await this.channels.send(config, message);
        return null;
      } catch (error: unknown) {
        const known = error instanceof EgressError;
        const message_ = known ? error.message : 'the channel could not be used';
        if (!known || !error.retryable || i >= deliveryOptions.attempts - 1) {
          return message_;
        }
        await sleep(deliveryOptions.backoffMs[i] ?? 2000);
      }
    }
  }
}
