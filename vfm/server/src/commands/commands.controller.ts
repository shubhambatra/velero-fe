import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { parseBody } from '../common/parse-body';
import { orgIdParam } from '../orgs/orgs.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AllowsApiToken } from '../tokens/api-token.decorator';
import { CommandsService } from './commands.service';

/**
 * Commands for one cluster's agent (PLAN.md §10). Every route is behind the RBAC
 * guard, which also answers 404 for a cluster that is not in the org. A request
 * returns `202` with the command id; the outcome is read back, because the agent
 * may be offline, slow, or gone.
 *
 * `refresh-status` needs only `cluster:read`: it asks the agent to re-read
 * Velero's version and plugins, which changes nothing the caller could not see.
 */
@ApiTags('commands')
@Controller('orgs/:orgId/clusters/:clusterId')
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Post('refresh-status')
  @HttpCode(HttpStatus.ACCEPTED)
  @AllowsApiToken()
  @RequirePermission('cluster:read')
  @ApiOperation({
    summary: 'Ask the agent to re-read Velero’s version and plugins',
    description: 'Returns 202 with the command; poll `/commands/{id}` for the result.',
  })
  refreshStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
  ) {
    return this.commands.enqueue(
      parseBody(orgIdParam, orgId),
      parseBody(orgIdParam, clusterId),
      user.id,
      'REFRESH_STATUS',
    );
  }

  @Get('commands')
  @AllowsApiToken()
  @RequirePermission('cluster:read')
  @ApiOperation({ summary: 'The most recent commands for this cluster' })
  async list(@Param('orgId') orgId: string, @Param('clusterId') clusterId: string) {
    return {
      commands: await this.commands.list(
        parseBody(orgIdParam, orgId),
        parseBody(orgIdParam, clusterId),
      ),
    };
  }

  @Get('commands/:commandId')
  @AllowsApiToken()
  @RequirePermission('cluster:read')
  @ApiOperation({ summary: 'One command and its outcome' })
  get(
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('commandId') commandId: string,
  ) {
    return this.commands.get(
      parseBody(orgIdParam, orgId),
      parseBody(orgIdParam, clusterId),
      parseBody(orgIdParam, commandId),
    );
  }

  @Post('commands/:commandId/cancel')
  @HttpCode(HttpStatus.OK)
  @AllowsApiToken()
  @RequirePermission('cluster:read')
  @ApiOperation({
    summary: 'Cancel a command the agent has not started',
    description: '409 once the agent has acknowledged it or it has finished.',
  })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('clusterId') clusterId: string,
    @Param('commandId') commandId: string,
  ) {
    return this.commands.cancel(
      parseBody(orgIdParam, orgId),
      parseBody(orgIdParam, clusterId),
      parseBody(orgIdParam, commandId),
      user.id,
    );
  }
}
