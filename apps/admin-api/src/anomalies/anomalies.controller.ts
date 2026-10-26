import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import { AnomaliesService } from './anomalies.service';

@Controller('tenants/:tenantId')
export class AnomaliesController {
  constructor(private readonly anomalies: AnomaliesService) {}

  @AutomationScope('alerts:read')
  @Get('anomalies')
  @Header('Cache-Control', 'no-store')
  list(@Param('tenantId') tenantId: string, @Query('state') state?: string) {
    return this.anomalies.list(tenantId, state);
  }

  @AutomationScope('alerts:read')
  @Get('anomaly-settings')
  @Header('Cache-Control', 'no-store')
  settings(@Param('tenantId') tenantId: string) {
    return this.anomalies.settings(tenantId);
  }

  @AutomationScope('alerts:write')
  @Put('anomaly-settings')
  @Header('Cache-Control', 'no-store')
  save(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.anomalies.save(tenantId, body);
  }
}
