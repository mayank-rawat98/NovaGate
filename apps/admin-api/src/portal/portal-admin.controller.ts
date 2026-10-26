import { Body, Controller, Get, Header, Param, Put } from '@nestjs/common';
import { PortalService } from './portal.service';
import { PortalDevelopersService } from './portal-developers.service';

/** Workspace-session administration of the developer portal. */
@Controller('tenants/:tenantId')
export class PortalAdminController {
  constructor(
    private readonly portal: PortalService,
    private readonly developers: PortalDevelopersService,
  ) {}

  @Get('portal-settings')
  @Header('Cache-Control', 'no-store')
  settings(@Param('tenantId') tenantId: string) {
    return this.portal.getSettings(tenantId);
  }

  @Put('portal-settings')
  @Header('Cache-Control', 'no-store')
  save(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.portal.saveSettings(tenantId, body);
  }

  /** Preview of what the published catalog shows, even while disabled. */
  @Get('portal/routes')
  @Header('Cache-Control', 'no-store')
  routes(@Param('tenantId') tenantId: string) {
    return this.portal.catalog(tenantId, false);
  }

  @Get('portal/developers')
  @Header('Cache-Control', 'no-store')
  list(@Param('tenantId') tenantId: string) {
    return this.developers.listDevelopers(tenantId);
  }

  @Put('portal/developers/:developerId')
  @Header('Cache-Control', 'no-store')
  status(
    @Param('tenantId') tenantId: string,
    @Param('developerId') developerId: string,
    @Body() body: unknown,
  ) {
    return this.developers.setStatus(tenantId, developerId, body);
  }
}
