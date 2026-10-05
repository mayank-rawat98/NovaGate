import { Controller, Get, Param, Query } from '@nestjs/common';
import { TracesService } from './traces.service';
@Controller('tenants/:tenantId/traces')
export class TracesController {
  constructor(private readonly traces: TracesService) {}
  @Get()
  list(
    @Param('tenantId') tenantId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.traces.list(tenantId, query);
  }
  @Get(':traceId')
  detail(
    @Param('tenantId') tenantId: string,
    @Param('traceId') traceId: string,
  ) {
    return this.traces.detail(tenantId, traceId);
  }
}
