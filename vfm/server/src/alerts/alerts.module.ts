import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { AlertEvaluator } from './alert-evaluator';
import { AlertRulesService } from './alert-rules.service';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { ChannelNotifier } from './channels/channel-notifier';
import { ChannelsController } from './channels/channels.controller';
import { ChannelsService } from './channels/channels.service';
import { AlertNotifier } from './notifier';

/** The alert engine, its rules and its history (PLAN.md §16 day 32). Channels and delivery: day 33. */
@Module({
  imports: [AuthModule, OrgsModule],
  controllers: [AlertsController, ChannelsController],
  providers: [
    AlertsService,
    AlertRulesService,
    AlertEvaluator,
    ChannelsService,
    ChannelNotifier,
    { provide: AlertNotifier, useExisting: ChannelNotifier },
  ],
  exports: [AlertsService, AlertEvaluator],
})
export class AlertsModule {}
