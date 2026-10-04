import {
  Controller,
  Header,
  Get,
  Post,
  Param,
  Body,
  StreamableFile,
} from '@nestjs/common';
import { LogExportService } from './log-export.service';

@Controller('tenants/:tenantId/log-exports')
export class LogExportController {
  constructor(private readonly exports: LogExportService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('tenantId') tenantId: string) {
    return this.exports.list(tenantId);
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Param('tenantId') tenantId: string, @Body() filter: unknown) {
    return this.exports.create(tenantId, filter);
  }
  @Get(':id/download')
  @Header('Cache-Control', 'no-store')
  async download(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    const stream = await this.exports.download(tenantId, id);
    return new StreamableFile(stream, {
      type: 'application/x-ndjson',
      disposition: `attachment; filename="novagate-logs-${id.toLowerCase()}.ndjson"`,
    });
  }
}
