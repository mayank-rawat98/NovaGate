import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { AutomationTokensService } from './automation-tokens.service';

/**
 * Token management deliberately has no AutomationScope: only an interactive
 * tenant session can mint, list or revoke tokens, so a token cannot widen itself.
 */
@Controller('tenants/:tenantId/automation-tokens')
export class AutomationTokensController {
  constructor(private readonly tokens: AutomationTokensService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('tenantId') tenantId: string) {
    return this.tokens.list(tenantId);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.tokens.create(tenantId, body);
  }

  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  revoke(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.tokens.revoke(tenantId, id);
  }
}
