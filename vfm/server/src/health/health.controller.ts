import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** Shape of a dependency check in the readiness response. */
export interface DependencyStatus {
  status: 'up' | 'down';
  error?: string;
}

export interface ReadinessResponse {
  status: 'ok' | 'error';
  checks: {
    postgres: DependencyStatus;
    redis: DependencyStatus;
  };
}

/**
 * Liveness and readiness (PLAN.md §10).
 *
 * The distinction matters operationally: liveness answers "should Kubernetes
 * restart this process", readiness answers "should the load balancer send it
 * traffic". A database outage must not restart every replica, so Postgres and
 * Redis are checked only in readiness.
 *
 * Neither endpoint is authenticated — they are reachable only on the cluster
 * network and reveal nothing beyond up/down. `@Public()` is required because
 * `SessionGuard` is global: without it the kubelet's probes would get 401 and
 * every replica would restart-loop.
 */
@Public()
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Returns 200 while the process is able to serve requests.',
  })
  @ApiResponse({ status: 200, description: 'The process is alive.' })
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Reports whether PostgreSQL and Redis are reachable. Returns 503 when any dependency is down.',
  })
  @ApiResponse({ status: 200, description: 'All dependencies are reachable.' })
  @ApiResponse({ status: 503, description: 'At least one dependency is unreachable.' })
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const [postgres, redis] = await Promise.all([
      probe(() => this.prisma.ping()),
      probe(() => this.redis.ping()),
    ]);

    const ready = postgres.status === 'up' && redis.status === 'up';

    // A 200 carrying `status: "error"` would be silently treated as ready by
    // every probe implementation, so the status code has to carry the verdict.
    // The body is still returned so an operator can see which dependency failed.
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return { status: ready ? 'ok' : 'error', checks: { postgres, redis } };
  }
}

async function probe(check: () => Promise<unknown>): Promise<DependencyStatus> {
  try {
    await check();
    return { status: 'up' };
  } catch (error: unknown) {
    // The message can carry a connection string, so it is summarised rather
    // than forwarded verbatim (PLAN.md §12.1).
    return {
      status: 'down',
      error: error instanceof Error ? error.name : 'unknown error',
    };
  }
}
