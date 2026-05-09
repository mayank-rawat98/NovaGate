import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigPushService } from '../config-push/config-push.service';

function tenantSchema(tenantId: string): string {
  if (!/^[0-9a-f-]+$/i.test(tenantId)) throw new Error('Invalid tenantId');
  return `tenant_${tenantId.replace(/-/g, '_')}`;
}

@Controller('tenants/:tenantId/routes')
export class RoutesController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configPush: ConfigPushService,
  ) {}

  @Get()
  async findAll(@Param('tenantId') tenantId: string) {
    const schema = tenantSchema(tenantId);
    return this.dataSource.query(
      `SELECT * FROM ${schema}.routes WHERE "deletedAt" IS NULL ORDER BY "createdAt" ASC`,
    );
  }

  @Post()
  async create(@Param('tenantId') tenantId: string, @Body() body: any) {
    const schema = tenantSchema(tenantId);
    const rows = await this.dataSource.query(
      `INSERT INTO ${schema}.routes (method, "pathPattern", "serviceId", "authRequired", "rateLimitOverride", enabled)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        body.method,
        body.pathPattern,
        body.serviceId,
        body.authRequired ?? false,
        body.rateLimitOverride ?? null,
        body.enabled ?? true,
      ],
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
      `UPDATE ${schema}.routes
       SET method = COALESCE($2, method),
           "pathPattern" = COALESCE($3, "pathPattern"),
           "serviceId" = COALESCE($4, "serviceId"),
           "authRequired" = COALESCE($5, "authRequired"),
           "rateLimitOverride" = COALESCE($6, "rateLimitOverride"),
           enabled = COALESCE($7, enabled)
       WHERE id = $1 AND "deletedAt" IS NULL RETURNING *`,
      [
        id,
        body.method ?? null,
        body.pathPattern ?? null,
        body.serviceId ?? null,
        body.authRequired ?? null,
        body.rateLimitOverride ?? null,
        body.enabled ?? null,
      ],
    );
    await this.configPush.triggerUpdate(tenantId);
    return rows[0];
  }

  @Delete(':id')
  async remove(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    const schema = tenantSchema(tenantId);
    await this.dataSource.query(
      `UPDATE ${schema}.routes SET "deletedAt" = NOW() WHERE id = $1 AND "deletedAt" IS NULL`,
      [id],
    );
    await this.configPush.triggerUpdate(tenantId);
    return { success: true };
  }
}
