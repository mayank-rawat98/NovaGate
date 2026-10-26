import { Body, Controller, Get, Header, Param, Put } from '@nestjs/common';
import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import { GatewayPluginsService } from './gateway-plugins.service';

@Controller('tenants/:tenantId/gateway-plugins')
export class GatewayPluginsController {
  constructor(private readonly plugins: GatewayPluginsService) {}

  @Get()
  @AutomationScope('workspace:read')
  @Header('Cache-Control', 'no-store')
  get(@Param('tenantId') tenantId: string) {
    return this.plugins.get(tenantId);
  }

  /** Session-only: the kill switch is not delegated to automation tokens. */
  @Put()
  @Header('Cache-Control', 'no-store')
  save(@Param('tenantId') tenantId: string, @Body() input: unknown) {
    return this.plugins.save(tenantId, input);
  }
}
