import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ServicesService } from './services.service';
import { ServiceEntity } from './entities/service.entity';

@Controller('admin/services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get()
  async findAll(): Promise<ServiceEntity[]> {
    return this.servicesService.getAllServices();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<ServiceEntity> {
    return this.servicesService.getService(id);
  }

  @Post()
  async create(@Body() data: Partial<ServiceEntity>): Promise<ServiceEntity> {
    return this.servicesService.createService(data);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() data: Partial<ServiceEntity>,
  ): Promise<ServiceEntity> {
    return this.servicesService.updateService(id, data);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    await this.servicesService.deleteService(id);
  }
}
