import { Module } from '@nestjs/common';

import { OrgsModule } from '../orgs/orgs.module';
import { ApiTokensService } from './api-tokens.service';
import { TokensController } from './tokens.controller';

/** API tokens for automation (PLAN.md §8.3, §16 day 9). */
@Module({
  imports: [OrgsModule],
  controllers: [TokensController],
  providers: [ApiTokensService],
  exports: [ApiTokensService],
})
export class TokensModule {}
