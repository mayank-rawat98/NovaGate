import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PortalService } from './portal.service';
import { PortalDevelopersService } from './portal-developers.service';

/** Unauthenticated portal endpoints. TenantAuthGuard skips the portal prefix. */
@Controller('portal')
export class PortalPublicController {
  constructor(
    private readonly portal: PortalService,
    private readonly developers: PortalDevelopersService,
  ) {}

  @Get('resolve')
  @Header('Cache-Control', 'public, max-age=60')
  resolve(@Query('host') host: unknown) {
    return this.portal.resolveDomain(host);
  }

  @Get(':tenantId/catalog')
  @Header('Cache-Control', 'public, max-age=30')
  catalog(@Param('tenantId') tenantId: string) {
    return this.portal.catalog(tenantId, true);
  }

  @Get(':tenantId/catalog/:routeId')
  @Header('Cache-Control', 'public, max-age=30')
  entry(
    @Param('tenantId') tenantId: string,
    @Param('routeId') routeId: string,
  ) {
    return this.portal.catalogEntry(tenantId, routeId);
  }

  @Post(':tenantId/developers/register')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async register(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    await this.developers.register(tenantId, body);
    return {
      message:
        'If this email can register, a confirmation link has been sent. Check your inbox to finish signing up.',
    };
  }

  @Post(':tenantId/developers/verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  verify(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.developers.verifyEmail(tenantId, body);
  }

  @Post(':tenantId/developers/login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  login(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.developers.login(tenantId, body);
  }
}
