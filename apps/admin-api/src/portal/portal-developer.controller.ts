import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PortalDevelopersService } from './portal-developers.service';
import {
  PortalDeveloperGuard,
  type DeveloperRequest,
} from './portal-developer.guard';

/** A signed-in developer's own profile, keys and usage. */
@Controller('portal/:tenantId/me')
@UseGuards(PortalDeveloperGuard)
export class PortalDeveloperController {
  constructor(private readonly developers: PortalDevelopersService) {}

  @Get()
  profile(@Req() req: DeveloperRequest) {
    return req.developer?.profile;
  }

  @Get('keys')
  keys(@Req() req: DeveloperRequest) {
    return this.developers.listKeys(principal(req));
  }

  @Post('keys')
  create(@Req() req: DeveloperRequest, @Body() body: unknown) {
    return this.developers.createKey(principal(req), body);
  }

  @Delete('keys/:keyId')
  @HttpCode(200)
  revoke(@Req() req: DeveloperRequest, @Param('keyId') keyId: string) {
    return this.developers.revokeKey(principal(req), keyId);
  }

  @Get('keys/:keyId/usage')
  usage(
    @Req() req: DeveloperRequest,
    @Param('keyId') keyId: string,
    @Query('period') period = '24h',
  ) {
    return this.developers.usage(principal(req), keyId, period);
  }
}

function principal(req: DeveloperRequest) {
  // The guard always sets this; a missing value is a programming error.
  if (!req.developer) throw new Error('Portal developer is not authenticated');
  return req.developer;
}
