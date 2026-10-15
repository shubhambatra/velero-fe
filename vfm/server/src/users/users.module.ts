import { Global, Module } from '@nestjs/common';

import { UsersService } from './users.service';

/**
 * Global because `SessionGuard` runs on every request and needs to re-read the
 * user row (that re-read is what makes disabling an account take effect
 * immediately — see the guard).
 */
@Global()
@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
