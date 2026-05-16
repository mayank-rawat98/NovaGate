import { Controller, Post, Get, Put, Param, Body } from '@nestjs/common';
import { TenantsService } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  async create(@Body() body: { name: string; email: string }) {
    return this.tenantsService.createTenant(body.name, body.email);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.tenantsService.getTenant(id);
  }

  @Post(':id/rotate-key')
  async rotateKey(@Param('id') id: string) {
    return this.tenantsService.rotateKey(id);
  }

  @Put(':id/ca-cert')
  async setCaCert(
    @Param('id') id: string,
    @Body() body: { caCertPem: string | null },
  ) {
    return this.tenantsService.setCaCert(id, body.caCertPem);
  }
}
