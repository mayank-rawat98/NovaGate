import { Body, Controller, Get, Header, Param, Put } from '@nestjs/common';
import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import { RegionsService } from './regions.service';

@Controller('tenants/:tenantId/control-plane')
export class RegionsController {
  constructor(private readonly regions: RegionsService) {}

  @Get()
  @AutomationScope('workspace:read')
  @Header('Cache-Control', 'no-store')
  get(@Param('tenantId') tenantId: string) {
    return this.regions.get(tenantId);
  }

  /** Session-only, like other workspace-wide settings. */
  @Put()
  @Header('Cache-Control', 'no-store')
  save(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.regions.save(tenantId, body);
  }
}
