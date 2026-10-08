import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ExportDestinationsService } from './export-destinations.service';

@Controller('tenants/:tenantId/log-export-destinations')
export class ExportDestinationsController {
  constructor(private readonly destinations: ExportDestinationsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('tenantId') tenantId: string) {
    return this.destinations.list(tenantId);
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Param('tenantId') tenantId: string, @Body() input: unknown) {
    return this.destinations.create(tenantId, input);
  }
  @Put(':id')
  @Header('Cache-Control', 'no-store')
  update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.destinations.update(tenantId, id, input);
  }
  @Post(':id/rotate-key')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  rotate(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.destinations.rotateKey(tenantId, id, input);
  }
  @Delete(':id')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  remove(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.destinations.remove(tenantId, id, input);
  }
}
