import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { OrgsModule } from '../orgs/orgs.module';
import { RbacModule } from '../rbac/rbac.module';
import { EventsService } from './events.service';
import { StreamController } from './stream.controller';

/** Global: the streams, commands and inventory modules all announce changes. */
@Global()
@Module({
  imports: [AuthModule, OrgsModule, RbacModule],
  controllers: [StreamController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
