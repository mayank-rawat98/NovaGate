import { Body, Controller, Get, Header, Param, Put } from '@nestjs/common';
import { LogRetentionService } from './log-retention.service';
@Controller('tenants/:tenantId/log-retention')
export class LogRetentionController {
  constructor(private readonly retention: LogRetentionService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Param('tenantId') tenantId: string) {
    return this.retention.get(tenantId);
  }
  @Put()
  @Header('Cache-Control', 'no-store')
  save(@Param('tenantId') tenantId: string, @Body() input: unknown) {
    return this.retention.save(tenantId, input);
  }
}
