import { Injectable, Logger } from '@nestjs/common';

export type NotificationKind = 'fired' | 'resolved' | 'renotify';

export interface AlertNotification {
  kind: NotificationKind;
  orgId: string;
  rule: { id: string; name: string; type: string };
  event: {
    id: string;
    clusterId: string;
    fingerprint: string;
    payload: Record<string, unknown>;
    firedAt: Date;
    resolvedAt: Date | null;
  };
  /** The channels the rule names; never empty (a rule with none is not notified at all). */
  channelIds: string[];
}

/**
 * Where the engine hands a notification (PLAN.md §16 day 33 supplies the channels). The engine
 * decides *when* — a condition appeared, went away, or has stayed for a re-notify interval — and
 * whether the rule names any channel; delivery, retry and signing belong to the implementation.
 *
 * `notify` resolving means "taken over"; the engine then records the time. A throw means it was
 * not, and the same notification is offered again on the next evaluation.
 */
export abstract class AlertNotifier {
  abstract notify(notification: AlertNotification): Promise<void>;
}

/** Until channels exist: the decision is logged and nothing leaves the process. */
@Injectable()
export class LoggingAlertNotifier extends AlertNotifier {
  private readonly logger = new Logger('Alerts');

  notify(n: AlertNotification): Promise<void> {
    this.logger.log(
      `alert ${n.kind}: rule "${n.rule.name}" (${n.rule.type}) ${n.event.fingerprint} on cluster ${n.event.clusterId}`,
    );
    return Promise.resolve();
  }
}
