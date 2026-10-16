import { Module } from '@nestjs/common';

import { StreamsService } from './streams.service';

/**
 * Connected agents: the registry, routing and status. A separate module so the
 * clusters module (which revokes) and the gateway (which attaches) can both use
 * it without depending on each other.
 */
@Module({
  providers: [StreamsService],
  exports: [StreamsService],
})
export class StreamsModule {}
