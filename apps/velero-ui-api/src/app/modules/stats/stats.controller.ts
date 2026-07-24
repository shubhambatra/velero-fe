import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { StatsService } from '@velero-ui-api/modules/stats/stats.service';
import { Observable } from 'rxjs';
import {
  Action,
  BackupsNextScheduled,
  BackupsStatusStats,
  BackupsSuccessRateStats,
  BasicStats,
  RestoresStatusStats,
  RestoresSuccessRateStats,
} from '@velero-ui/shared-types';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { CheckPolicies } from '@velero-ui-api/shared/decorators/check-policies.decorator';
import { Subject } from '@velero-ui-api/shared/decorators/subject.decorator';
import { AppAbility } from '@velero-ui-api/shared/modules/casl/casl-ability.factory';
import { PluralsNames, Resources } from '@velero-ui/velero';

@Controller('stats')
@Subject(Resources.BACKUP.plural)
@UseInterceptors(CacheInterceptor)
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  @CheckPolicies((ability: AppAbility, resource: PluralsNames) =>
    ability.can(Action.Read, resource)
  )
  public getBasicStats(): Observable<BasicStats> {
    return this.statsService.getBasicStats();
  }

  @Get('/backups/status')
  @CheckPolicies((ability: AppAbility, resource: PluralsNames) =>
    ability.can(Action.Read, resource)
  )
  public getBackupsStatus(): Observable<BackupsStatusStats> {
    return this.statsService.getBackupsStatus();
  }

  @Get('/backups/success-rate')
  @CheckPolicies((ability: AppAbility, resource: PluralsNames) =>
    ability.can(Action.Read, resource)
  )
  public getBackupsSuccessRate(): Observable<BackupsSuccessRateStats> {
    return this.statsService.getBackupsSuccessRate();
  }

  @Get('/restores/status')
  @CheckPolicies((ability: AppAbility) =>
    ability.can(Action.Read, Resources.RESTORE.plural)
  )
  public getRestoresStatus(): Observable<RestoresStatusStats> {
    return this.statsService.getRestoresStatus();
  }

  @Get('/restores/success-rate')
  @CheckPolicies((ability: AppAbility) =>
    ability.can(Action.Read, Resources.RESTORE.plural)
  )
  public getRestoresSuccessRate(): Observable<RestoresSuccessRateStats> {
    return this.statsService.getRestoresSuccessRate();
  }

  @Get('/backups/next-scheduled')
  @CheckPolicies((ability: AppAbility, resource: PluralsNames) =>
    ability.can(Action.Read, resource)
  )
  public getNextScheduledBackups(): Observable<BackupsNextScheduled[]> {
    return this.statsService.getNextScheduledBackups();
  }

  @Get('/backups/latest')
  @CheckPolicies((ability: AppAbility, resource: PluralsNames) =>
    ability.can(Action.Read, resource)
  )
  public getBackupLatest() {
    return this.statsService.getBackupLatest();
  }

  @Get('/unscheduled-namespaces')
  @CheckPolicies((ability: AppAbility, resource: PluralsNames) =>
    ability.can(Action.Read, resource)
  )
  public getUnscheduledNamespaces(): Observable<string[]> {
    return this.statsService.getUnscheduledNamespaces();
  }
}
