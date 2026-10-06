import type { Response } from 'express';
import {
  Controller,
  Header,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  StreamableFile,
  Res,
} from '@nestjs/common';
import { LogExportService } from './log-export.service';
import { LogExportSchedulerService } from './log-export-scheduler.service';

@Controller('tenants/:tenantId/log-exports')
export class LogExportController {
  constructor(
    private readonly exports: LogExportService,
    private readonly schedules: LogExportSchedulerService,
  ) {}
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
  @Get('schedule')
  @Header('Cache-Control', 'no-store')
  schedule(@Param('tenantId') tenantId: string) {
    return this.schedules.get(tenantId);
  }
  @Put('schedule')
  @Header('Cache-Control', 'no-store')
  saveSchedule(@Param('tenantId') tenantId: string, @Body() input: unknown) {
    return this.schedules.save(tenantId, input);
  }
  @Delete('schedule')
  @Header('Cache-Control', 'no-store')
  removeSchedule(@Param('tenantId') tenantId: string, @Body() input: unknown) {
    return this.schedules.remove(tenantId, input);
  }
  @Get(':id/download')
  @Header('Cache-Control', 'no-store')
  async download(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const stream = await this.exports.download(tenantId, id);
    const cancel = () => stream.destroy();
    response.once('close', cancel);
    stream.once('close', () => response.off('close', cancel));
    if (response.destroyed) stream.destroy();
    return new StreamableFile(stream, {
      type: 'application/x-ndjson',
      disposition: `attachment; filename="novagate-logs-${id.toLowerCase()}.ndjson"`,
    });
  }
  @Post(':id/retry')
  @Header('Cache-Control', 'no-store')
  retry(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.exports.retry(tenantId, id);
  }
}
