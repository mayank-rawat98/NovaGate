import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigImportService } from './config-import.service';

@Controller('tenants/:tenantId')
export class ConfigImportController {
  constructor(private readonly service: ConfigImportService) {}
  @AutomationScope('config:read')
  @Get('export')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/yaml; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="novagate-config.yaml"')
  export(@Param('tenantId') tenant: string) {
    return this.service.export(tenant);
  }
  // Previews (the default) are write-free, so a read token can plan changes.
  @AutomationScope((request) =>
    request.query.dryRun === 'false' ? 'config:write' : 'config:read',
  )
  @Post('import')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  import(
    @Param('tenantId') tenant: string,
    @Body() body: unknown,
    @Query('dryRun') dryRun: string | undefined,
    @Headers('if-match') revision: string | undefined,
    @Headers('content-type') contentType: string | undefined,
  ) {
    if (
      ![
        'application/json',
        'application/yaml',
        'text/yaml',
        'text/plain',
      ].includes(contentType?.split(';')[0].trim().toLowerCase() ?? '')
    )
      throw new UnsupportedMediaTypeException(
        'Send application/json or application/yaml.',
      );
    if (dryRun === undefined || dryRun === 'true')
      return this.service.preview(tenant, body);
    if (dryRun !== 'false')
      throw new BadRequestException('dryRun must be true or false.');
    return this.service.apply(
      tenant,
      body,
      revision?.replace(/^"(.*)"$/, '$1'),
    );
  }
}
