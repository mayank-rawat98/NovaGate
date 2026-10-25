import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { TracesService } from './traces.service';
@Controller('tenants/:tenantId/traces')
export class TracesController {
  constructor(private readonly traces: TracesService) {}
  @AutomationScope('analytics:read')
  @Get()
  list(
    @Param('tenantId') tenantId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.traces.list(tenantId, query);
  }
  @AutomationScope('analytics:read')
  @Get(':traceId')
  detail(
    @Param('tenantId') tenantId: string,
    @Param('traceId') traceId: string,
  ) {
    return this.traces.detail(tenantId, traceId);
  }
}
