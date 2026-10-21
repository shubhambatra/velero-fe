import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';

import { HttpMetricsMiddleware } from './http-metrics.middleware';

@Module({ providers: [HttpMetricsMiddleware] })
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}
