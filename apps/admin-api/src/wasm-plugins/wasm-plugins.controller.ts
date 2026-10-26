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
import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import { WasmPluginsService } from './wasm-plugins.service';

@Controller('tenants/:tenantId/wasm-plugins')
export class WasmPluginsController {
  constructor(private readonly plugins: WasmPluginsService) {}

  @Get()
  @AutomationScope('workspace:read')
  @Header('Cache-Control', 'no-store')
  state(@Param('tenantId') tenantId: string) {
    return this.plugins.state(tenantId);
  }

  /** Session-only: installing code that runs on gateways is not delegated. */
  @Post('install')
  @HttpCode(200)
  install(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.plugins.install(tenantId, body);
  }

  @Post('upload')
  @HttpCode(200)
  upload(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.plugins.upload(tenantId, body);
  }

  @Delete(':name')
  remove(@Param('tenantId') tenantId: string, @Param('name') name: string) {
    return this.plugins.remove(tenantId, name);
  }
}
