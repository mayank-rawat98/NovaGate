import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Put,
} from '@nestjs/common';
import { ExportDeliveryStoreService } from './export-delivery-store.service';

@Controller('tenants/:tenantId/log-export-destinations/:id/delivery')
export class ExportDeliveryController {
  constructor(private readonly deliveries: ExportDeliveryStoreService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  state(@Param('tenantId') tenant: string, @Param('id') destination: string) {
    return this.deliveries.deliveryState(tenant, destination);
  }
  @Put()
  @Header('Cache-Control', 'no-store')
  save(
    @Param('tenantId') tenant: string,
    @Param('id') destination: string,
    @Body() body: unknown,
  ) {
    return this.deliveries.saveSchedule(tenant, destination, body);
  }
  @Delete()
  @Header('Cache-Control', 'no-store')
  remove(
    @Param('tenantId') tenant: string,
    @Param('id') destination: string,
    @Body() body: unknown,
  ) {
    return this.deliveries.removeSchedule(tenant, destination, body);
  }
  @Get('history')
  @Header('Cache-Control', 'no-store')
  history(@Param('tenantId') tenant: string, @Param('id') destination: string) {
    return this.deliveries.historyState(tenant, destination, true);
  }
}
