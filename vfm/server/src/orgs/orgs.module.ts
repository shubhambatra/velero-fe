import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { OrgAccessService } from './org-access.service';
import { OrgsController } from './orgs.controller';
import { OrgsService } from './orgs.service';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

/** Organizations, members, invitations and teams (PLAN.md §8.1, §16 day 6). */
@Module({
  imports: [AuthModule],
  controllers: [OrgsController, InvitesController, TeamsController],
  providers: [OrgAccessService, OrgsService, InvitesService, TeamsService],
  exports: [OrgAccessService],
})
export class OrgsModule {}
