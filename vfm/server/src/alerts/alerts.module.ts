import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { AlertEvaluator } from './alert-evaluator';
import { AlertRulesService } from './alert-rules.service';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { AlertNotifier, LoggingAlertNotifier } from './notifier';

/** The alert engine, its rules and its history (PLAN.md §16 day 32). Channels arrive on day 33. */
@Module({
  imports: [AuthModule, OrgsModule],
  controllers: [AlertsController],
  providers: [
    AlertsService,
    AlertRulesService,
    AlertEvaluator,
    { provide: AlertNotifier, useClass: LoggingAlertNotifier },
  ],
  exports: [AlertsService, AlertEvaluator],
})
export class AlertsModule {}
