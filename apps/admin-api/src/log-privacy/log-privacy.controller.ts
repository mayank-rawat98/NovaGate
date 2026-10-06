import { Body, Controller, Get, Header, Param, Put } from '@nestjs/common';
import { LogPrivacyService } from './log-privacy.service';
@Controller('tenants/:tenantId/log-privacy')
export class LogPrivacyController {
  constructor(private readonly privacy: LogPrivacyService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Param('tenantId') tenantId: string) {
    return this.privacy.get(tenantId);
  }
  @Put()
  @Header('Cache-Control', 'no-store')
  save(@Param('tenantId') tenantId: string, @Body() input: unknown) {
    return this.privacy.save(tenantId, input);
  }
}
