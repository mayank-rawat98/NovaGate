import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';

function tenantSchema(tenantId: string): string {
  if (!/^[0-9a-f-]+$/i.test(tenantId)) throw new Error('Invalid tenantId');
  return `tenant_${tenantId.replace(/-/g, '_')}`;
}

@Controller('tenants/:tenantId/services')
export class ServicesController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configPush: ConfigPushService,
  ) {}

  @Get()
  async findAll(@Param('tenantId') tenantId: string) {
    const schema = tenantSchema(tenantId);
    return this.dataSource.query(
      `SELECT * FROM ${schema}.services WHERE "deletedAt" IS NULL ORDER BY "createdAt" ASC`,
    );
  }

  @Post()
  async create(@Param('tenantId') tenantId: string, @Body() body: any) {
    const schema = tenantSchema(tenantId);
    const rows = await this.dataSource.query(
      `INSERT INTO ${schema}.services (name, "targetUrl", "healthCheckPath", "timeoutMs")
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.name, body.targetUrl, body.healthCheckPath ?? null, body.timeoutMs ?? 10000],
    );
    await this.configPush.triggerUpdate(tenantId);
    return rows[0];
  }

  @Put(':id')
  async update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    const schema = tenantSchema(tenantId);
    const rows = await this.dataSource.query(
      `UPDATE ${schema}.services
       SET name = COALESCE($2, name),
           "targetUrl" = COALESCE($3, "targetUrl"),
           "healthCheckPath" = COALESCE($4, "healthCheckPath"),
           "timeoutMs" = COALESCE($5, "timeoutMs")
       WHERE id = $1 AND "deletedAt" IS NULL RETURNING *`,
      [
        id,
        body.name ?? null,
        body.targetUrl ?? null,
        body.healthCheckPath ?? null,
        body.timeoutMs ?? null,
      ],
    );
    await this.configPush.triggerUpdate(tenantId);
    return rows[0];
  }

  @Delete(':id')
  async remove(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    const schema = tenantSchema(tenantId);
    await this.dataSource.query(
      `UPDATE ${schema}.services SET "deletedAt" = NOW() WHERE id = $1 AND "deletedAt" IS NULL`,
      [id],
    );
    await this.configPush.triggerUpdate(tenantId);
    return { success: true };
  }
}
