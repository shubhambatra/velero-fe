import { forwardRef, Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { UsersService } from './users.service';

/**
 * Global because `SessionGuard` runs on every request and needs to re-read the
 * user row (that re-read is what makes disabling an account take effect
 * immediately — see the guard).
 */
@Global()
@Module({
  // forwardRef because the two modules genuinely need each other: auth reads
  // users to log them in, and users needs PasswordService to verify a password
  // for sudo re-authentication. Splitting PasswordService into its own module
  // would remove the cycle but scatter the auth primitives.
  imports: [forwardRef(() => AuthModule)],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
