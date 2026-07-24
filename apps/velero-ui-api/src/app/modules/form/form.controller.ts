import { Controller, Get } from '@nestjs/common';
import { FormService } from '@velero-ui-api/modules/form/form.service';
import { Observable } from 'rxjs';
import { Action, FormList } from '@velero-ui/shared-types';
import { CheckPolicies } from '@velero-ui-api/shared/decorators/check-policies.decorator';
import { AppAbility } from '@velero-ui-api/shared/modules/casl/casl-ability.factory';
import { Resources } from '@velero-ui/velero';

@Controller('form')
export class FormController {
  constructor(private readonly formService: FormService) {}

  @Get('/schedules')
  @CheckPolicies((ability: AppAbility) =>
    ability.can(Action.Read, Resources.SCHEDULE.plural)
  )
  public getFormSchedules(): Observable<FormList<string>> {
    return this.formService.getSchedules();
  }

  @Get('/backups')
  @CheckPolicies((ability: AppAbility) =>
    ability.can(Action.Read, Resources.BACKUP.plural)
  )
  public getFormBackups(): Observable<FormList<string>> {
    return this.formService.getBackups();
  }

  @Get('/namespaces')
  @CheckPolicies((ability: AppAbility) =>
    ability.can(Action.Read, Resources.BACKUP.plural)
  )
  public getNamespaces(): Observable<FormList<string>> {
    return this.formService.getNamespaces();
  }

  @Get('/storage-locations')
  @CheckPolicies((ability: AppAbility) =>
    ability.can(Action.Read, Resources.BACKUP_STORAGE_LOCATION.plural)
  )
  public getStorageLocations(): Observable<FormList<string>> {
    return this.formService.getStorageLocations();
  }

  @Get('/snapshot-locations')
  @CheckPolicies((ability: AppAbility) =>
    ability.can(Action.Read, Resources.VOLUME_SNAPSHOT_LOCATION.plural)
  )
  public getSnapshotLocations(): Observable<FormList<string>> {
    return this.formService.getSnapshotLocations();
  }

  @Get('/secrets')
  @CheckPolicies((ability: AppAbility) =>
    ability.can(Action.Read, Resources.BACKUP_STORAGE_LOCATION.plural)
  )
  public getFormSecrets(): Observable<FormList<string>> {
    return this.formService.getSecrets();
  }

  @Get('/config-maps')
  @CheckPolicies((ability: AppAbility) =>
    ability.can(Action.Read, Resources.BACKUP_STORAGE_LOCATION.plural)
  )
  public getFormConfigMaps(): Observable<FormList<string>> {
    return this.formService.getConfigMaps();
  }
}
